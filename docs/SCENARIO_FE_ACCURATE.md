# Kịch bản đo — khớp luồng FE thật (2026-06-06)

Kịch bản đã được dựng lại để đo **đúng kết quả thực tế**:

- **Event gửi tin:** `message:send` (đúng `socketEvent.MSGSEND` của FE) — KHÔNG
  còn `send_ask` (event không tồn tại ở BE).
- **"Gửi thành công" = nhận `message:upsert` echo cùng `id` trong ≤
  `DELIVER_WINDOW_MS` (15s)** — đúng cơ chế `autoFailIfUnsent(roomId, id, 15000)`
  của `useMessageStore.sendMessage`. KHÔNG dựa vào socket.io ack (FE không ack).
- **Đo đầy đủ độ trễ** `avg/min/med/p95/p99/max` cho connect, join, giao tin
  (upsert echo), và ack (khi `REQUEST_ACK=1`).
- **Mode mặc định `rate`** (throughput thực tế); `burst` để đo đỉnh.

Metric chính:
- Kết nối: `ws_connected`, `ws_join_ack_ok`.
- Tin thành công: `ws_msg_delivered` ✅ / thất bại: `ws_msg_failed` ❌.
- Độ trễ giao tin: `ws_msg_deliver_time` (p95/p99/max = UX thật).

Chi tiết đầy đủ + lý do thay đổi: [`plan/LOADTEST_REBUILD_FE_ACCURATE.md`](../../plan/LOADTEST_REBUILD_FE_ACCURATE.md).

> `burst-loadtest-analysis-20260605.md` là phân tích run CŨ (dùng ack làm tiêu
> chí) — giữ làm lịch sử, không còn phản ánh kịch bản hiện tại.
