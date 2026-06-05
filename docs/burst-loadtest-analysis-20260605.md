# Phân tích độ trễ — k6 Burst Load Test

**Run ID:** `20260605-211854`  
**Thời gian:** 2026-06-05T14:21:07Z  
**Báo cáo JSON:** `test/k6/reports/run-20260605-211854.json`  
**Kịch bản:** burst — 1000 VU × 1 tin nhắn đồng thời (`fireAt`)

---

## 1. Tóm tắt kết quả

| Chỉ số | Giá trị |
|---|---|
| Thời lượng test | 118.1s |
| Target VU | 1000 |
| Checks pass | **100%** |
| Connect error | **0** |
| Send ack ok | **1000/1000 (100%)** |
| Send ack timeout | **0** |

**Kết luận ngắn:** Hệ thống **chịu được burst** 1000 socket + 1000 tin nhắn mà không lỗi chức năng. Độ trễ cao (~16s median, ~19s p95) là vấn đề **throughput/latency** trên đường gửi tin, không phải lỗi kết nối WebSocket.

---

## 2. Cấu hình test

```env
USER_COUNT=1000
MSGS_PER_VU=1
RAMP_DURATION=30
CONNECT_MARGIN_MS=45000
THINK_AFTER_GO=15
MODE=burst
```

- VU connect rải trong 30s, chờ thêm 45s margin, rồi **1000 tin bắn cùng `fireAt`**
- Mỗi room ~100 member (prepare shard `ROOM_SIZE=100` → ~10 room)
- Entry point: `ws://nginx:8080` → Cloud Run `socket-service` + `chat-service`

---

## 3. Bảng metric chi tiết

### 3.1 Latency (ms)

| Metric | avg | med | p95 | p99 | max |
|---|---|---|---|---|---|
| `ws_connect_time` | 1 526 | **398** | 6 700 | 12 023 | 27 339 |
| `ws_join_time` | 423 | **84** | 1 754 | 3 374 | 26 495 |
| `ws_send_ack_time` | 15 426 | **16 342** | **19 125** | **20 311** | **20 995** |
| `ws_message_round_trip` | 13 879 | **14 679** | **18 798** | **19 175** | 25 634 |

### 3.2 Counter

| Counter | Giá trị | Ý nghĩa |
|---|---|---|
| `ws_connected` | 1000 | Socket upgrade + connect OK |
| `ws_join_ack_ok` | 1000 | Join room OK |
| `ws_join_no_ack` | 7 | Join ack muộn (không ảnh hưởng check) |
| `ws_fired` / `ws_message_sent` | 1000 | Mọi VU đã gửi tin |
| `ws_send_ack_ok` | 1000 | Ack từ server OK |
| `ws_send_ack_timeout` | 0 | Không timeout ack phía k6 |
| `ws_upsert_timeout` | **95** | 9.5% không nhận `message:upsert` echo trước khi đóng socket |

---

## 4. Độ trễ nằm ở đâu?

### 4.1 Không phải connect / join

- Median connect **398ms**, join **84ms** — bình thường cho burst lớn
- `ws_connect_error = 0`, `join_ack_fail = 0`
- p95 connect/join cao (~6.7s / ~1.7s) chỉ ảnh hưởng VU connect muộn trong ramp, không ảnh hưởng send

### 4.2 Nút thắt chính: đường `message:send` → gRPC → MongoDB

Luồng xử lý khi client gửi tin:

```
k6 VU
  → socket-service (Cloud Run)
    → gRPC CreateNewMsg
      → chat-service: createMessage()
        ① validate member / room cache
        ② findOneAndUpdate message + aggregate pipeline
        ③ broadcast message:upsert qua Redis adapter  ← round-trip đo tại đây
        ④ await tail: state update, bulkWrite unread, Kafka (noti, embedding)
      ← gRPC response
    ← Socket.IO ack  ← send_ack_time đo tại đây
```

**`ws_send_ack_time`** = thời gian từ `message:send` đến ack callback — phụ thuộc **toàn bộ** `createMessage` + gRPC round-trip.

**`ws_message_round_trip`** = thời gian đến khi nhận `message:upsert` echo — upsert được phát **sau bước ②③**, **trước** khi tail (④) hoàn tất.

Bằng chứng trong code (`app-nest-be/apps/chat/src/handle-chat/handle-chat.service.ts`):

1. `aggregate(buildMessageDetailPipeline)` — hydrate message
2. `emitter.broadcastTo(..., MSGUPSERT, ...)` — phát realtime sớm
3. `await Promise.allSettled([...])` — tail blocking (unread bulkWrite, Kafka push, embedding)

Median round-trip (**14.7s**) < median ack (**16.3s**) → chênh ~1.6s khớp với thời gian tail + gRPC về socket.

### 4.3 Hàng đợi khi 1000 tin đồng thời

~1000 request `CreateNewMsg` cùng `fireAt` → chat-service nhận spike đồng thời.

Cloud Run `chat-service` (deploy):

```
max-instances=10
concurrency=100
timeout=60s
```

Lý thuyết ~1000 concurrent slot, nhưng thực tế:

- Cold start / scale lag
- MongoDB contention (10 room × ~100 write đồng thời)
- Request vào sau phải **chờ queue** → median ack ~16s

### 4.4 Trần gRPC ~20 giây

Socket gọi `Utils.dispatchGrpcRequest` với `timeoutMs = 20000` (`libs/helpers/src/utils.ts`).

| Dấu hiệu | Giá trị run |
|---|---|
| ack max | 20 995ms ≈ 20s + overhead |
| p95 ≈ p99 ≈ max | 19.1s → 20.3s → 21.0s |

→ Tail latency **dồn sát deadline 20s**, không trải dài ngẫu nhiên — đặc trưng **queue + hard timeout**, không phải bug client.

### 4.5 `upsert_timeout = 95` — vấn đề riêng

9.5% VU không nhận `message:upsert` trước khi socket đóng (grace window k6: `SEND_TIMEOUT_MS 15s + THINK_AFTER_GO 15s`).

Nguyên nhân có thể:

- Redis pub/sub adapter quá tải khi broadcast ~1000 upsert × ~100 member/room
- Socket-service delivery chậm dưới burst
- **Không** liên quan `send_ack_fail` (ack vẫn 100%)

---

## 5. Sơ đồ timeline burst

```
0s        30s              75s (fireAt)                    ~95s+
|---- ramp connect --------|-- margin --|
                              | 1000 message:send cùng lúc |
                              | queue chat-service          |
                              | med ack ~16s, p95 ~19s      |
```

---

## 6. Đã loại trừ

| Giả thuyết | Bằng chứng loại trừ |
|---|---|
| Socket connect fail | `connect_error = 0`, checks 100% |
| Join room fail | `join_ack_ok = 1000` |
| Message bị reject | `send_ack_fail = 0` |
| k6 timeout cắt ack | `send_ack_timeout = 0`; max ack 21s < grace 30s |
| Lỗi protocol test | `ws upgrade 101` 1000/1000 |

---

## 7. Thí nghiệm xác minh thêm

```powershell
cd D:\ITEveryDay\KhoaLuan\test

# A. Baseline idle — ack bình thường là bao nhiêu?
$env:USER_COUNT=10; .\scripts\run-test.ps1
# Kỳ vọng: send_ack p95 < 1s

# B. Burst nhỏ — queue có xuất hiện không?
$env:USER_COUNT=100; .\scripts\run-test.ps1
# So sánh p95 với run 1000

# C. Chỉ connect, không gửi tin (.env MSGS_PER_VU=0)
# Xác nhận connect/join nhanh, bottleneck chỉ ở send path
```

Trên Cloud Run logs:

- `chat-service`: latency `CreateNewMsg`, lỗi `DEADLINE_EXCEEDED`
- MongoDB: slow query trên `findOneAndUpdate`, `aggregate`, `bulkWrite`

---

## 8. Khuyến nghị tối ưu (theo impact)

| Ưu tiên | Hành động | Tác dụng kỳ vọng |
|---|---|---|
| **1** | Trả gRPC **ngay sau** `broadcastTo`; chuyển tail (unread, Kafka) sang queue/Bull `setImmediate` | Giảm ack từ ~16s → vài giây |
| **2** | Tăng `max-instances` / `concurrency` chat-service | Giảm queue burst |
| **3** | Giảm work trước broadcast: payload tối thiểu, bỏ/giảm `aggregate` trên hot path | Giảm thời gian đến upsert |
| **4** | Kafka noti/embedding fire-and-forget thật sự (không `await` tail) | Giảm blocking ack |
| **5** | Scale socket + Redis adapter | Giảm `upsert_timeout` |

---

## 9. Kết luận cho luận văn

| Tiêu chí | Đánh giá |
|---|---|
| **Tính đúng đắn** | Pass — 100% ack, 0% lỗi connect/send |
| **Khả năng chịu burst** | 1000 user gửi đồng thời — hệ thống không sập |
| **Độ trễ** | Cao — med ~16s, p95 ~19s; do queue + `createMessage` nặng + gRPC deadline 20s |
| **Realtime echo** | 90.5% nhận upsert kịp; 9.5% timeout delivery |
| **Nút thắt** | **chat-service** (`createMessage`), không phải socket connect |

> Hệ thống đạt **functional correctness** dưới burst 1000 user, nhưng **latency chưa đáp ứng UX realtime** (<1s). Đây là kết quả capacity hợp lệ cho môi trường Cloud Run + MongoDB shared, không phải bug load test.

---

## 10. Tài liệu liên quan

| File | Mô tả |
|---|---|
| `test/k6/loadtest.js` | Script k6, metric `ws_send_ack_time`, `ws_message_round_trip` |
| `test/k6/reports/run-20260605-211854.json` | Raw data run này |
| `app-nest-be/apps/socket/src/chat/chat-gateway.ts` | Handler `message:send` → gRPC |
| `app-nest-be/apps/chat/src/handle-chat/handle-chat.service.ts` | `createMessage` — broadcast + tail |
| `app-nest-be/libs/helpers/src/utils.ts` | gRPC timeout 20s |
| `app-nest-be/.github/workflows/deploy-chat.yml` | Cloud Run limits chat-service |

---

*Generated from analysis session — IChat KLTN load test, 2026-06-05.*
