# Dịch vụ báo cáo

Report Service chạy độc lập ở `http://localhost:3003`. Database `report_service` dùng tài khoản `report_user`, nằm trên MySQL riêng ở cổng `3307`. Order Service tiếp tục chạy ở `3002` với database và tài khoản riêng. Hai tiến trình có thể khởi động, dừng và triển khai riêng.

Report Service chỉ truy vấn database của mình. Dữ liệu sản phẩm và đơn hàng được gửi qua API HTTP dưới dạng snapshot; không JOIN hay kết nối vào database của dịch vụ khác. Đọc báo cáo dùng Bearer token được kiểm tra qua Auth Service. Ghi dữ liệu dùng khóa dịch vụ `X-Report-Key` riêng, không cho phép token người dùng ghi đè số liệu.

## Khởi động

Yêu cầu Node.js 22+ và MySQL 8.0.16+ (Compose dùng 8.4).

```powershell
npm install
# Nếu chưa có .env:
Copy-Item .env.example .env
```

Nếu đã có `.env`, bổ sung các biến `REPORT_*` từ `.env.example`; đặt `REPORT_INGEST_KEY` thành khóa bí mật riêng. Các biến `DB_*` và `PORT` của Order Service không ảnh hưởng đến Report Service.

```powershell
# Khởi động riêng database báo cáo bằng Docker Desktop:
docker compose up -d --wait report-mysql
npm run report:db:init
npm run report:start
```

Nếu dùng MySQL sẵn có, tạo database và tài khoản bằng tài khoản quản trị rồi cấu hình `REPORT_DB_*` tương ứng:

```sql
CREATE DATABASE report_service CHARACTER SET utf8mb4;
CREATE USER 'report_user'@'localhost' IDENTIFIED BY 'report_password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES
  ON report_service.* TO 'report_user'@'localhost';
```

`report:db:init` tạo bảng còn thiếu, không phải công cụ migration. `GET /health` kiểm tra kết nối Report DB và không yêu cầu token. Khi chưa nhận snapshot, các API báo cáo trả `503` kèm hướng dẫn đồng bộ.

## API

| Method | Endpoint | Chức năng |
|---|---|---|
| GET | `/health` | Kiểm tra dịch vụ và kết nối database |
| PUT | `/report-data` | Thay thế snapshot đầy đủ, yêu cầu `X-Report-Key` |
| GET | `/reports/summary` | Tổng tồn kho, số đơn hoàn thành, số lượng bán, doanh thu, chi phí, lợi nhuận |
| GET | `/reports/products` | Báo cáo từng sản phẩm, kể cả sản phẩm chưa bán |
| GET | `/reports/products/:id` | Báo cáo một sản phẩm |
| GET | `/reports/orders` | Báo cáo từng đơn, gồm trạng thái và chỉ tiêu tài chính |
| GET | `/reports/orders/:id` | Báo cáo một đơn |

Tất cả `/reports/*` yêu cầu `Authorization: Bearer <access_token>`. Có thể thêm `?from=2026-11-01&to=2026-11-22`; cả hai ngày được bao gồm, theo UTC. Mỗi cận đều có thể bỏ qua. Ngày sai hoặc khoảng đảo ngược trả `400`; ID hoặc dữ liệu trong kỳ không tồn tại trả `404`.

Các endpoint trả `{ "data": ..., "meta": { "captured_at": "...", "period": {}, "timezone": "UTC" } }`. `captured_at` là thời điểm của snapshot, không phải thời điểm gọi báo cáo. Số tiền và tổng số lượng từ `SUM` trả chuỗi để giữ chính xác. `completed_orders` là số đếm.

## Quy tắc tính

- Số lượng đã bán: tổng `quantity` của đơn `completed` trong kỳ.
- Doanh thu: tổng `quantity × unit_price` của những đơn đó.
- Chi phí: giá vốn hàng đã bán, tổng `quantity × unit_cost` tại thời điểm bán.
- Lợi nhuận: doanh thu trừ giá vốn, có thể âm. Đây là lợi nhuận gộp; chưa tính thuế, vận chuyển, chi phí vận hành hoặc hoàn trả.
- Đơn `pending` và `cancelled` có các chỉ tiêu bán hàng bằng 0. Danh sách đơn lọc theo `completed_at` với đơn hoàn thành, theo `created_at` với các trạng thái còn lại.
- Tồn kho là lượng tồn hiện tại trong snapshot mới nhất, không phải tồn kho lịch sử trong khoảng ngày lọc. Không lấy tồn kho trừ tiếp số lượng đã bán, vì dịch vụ sản phẩm quản lý tồn kho.
- Sản phẩm đã xóa khỏi danh mục vẫn xuất hiện nếu có trong lịch sử đơn hàng; `stock_quantity` là `null` vì không biết tồn kho. Tổng tồn kho chỉ cộng danh mục hiện có.

Tính toán tiền dùng MySQL `DECIMAL`, không cộng/trừ số thực JavaScript. Báo cáo tổng hợp tránh nhân đôi tồn kho khi một sản phẩm có nhiều dòng bán hàng.

## Đồng bộ qua API

Gửi JSON theo [report-snapshot.example.json](report-snapshot.example.json). Snapshot phải bao gồm **toàn bộ danh mục và lịch sử đơn cần báo cáo**, không phải chỉ bản ghi mới hay một trang dữ liệu. Bản ghi không có trong snapshot mới sẽ bị loại khỏi bản sao báo cáo. Nguồn gửi phải hoàn tất việc gom tất cả các trang trước khi gọi API.

```powershell
$key = 'YOUR_REPORT_INGEST_KEY'
Invoke-RestMethod -Method Put -Uri http://localhost:3003/report-data `
  -Headers @{ 'X-Report-Key' = $key } -ContentType 'application/json; charset=utf-8' `
  -InFile .\report-snapshot.example.json

$headers = @{ Authorization = 'Bearer YOUR_ACCESS_TOKEN' }
Invoke-RestMethod -Uri 'http://localhost:3003/reports/summary?from=2026-11-01&to=2026-11-22' -Headers $headers
Invoke-RestMethod -Uri 'http://localhost:3003/reports/products/1' -Headers $headers
Invoke-RestMethod -Uri 'http://localhost:3003/reports/orders/1' -Headers $headers
```

Snapshot ví dụ cho tổng tồn `13`, bán `2`, doanh thu `20.20`, giá vốn `12.10`, lợi nhuận `8.10`.

Hợp đồng đồng bộ:

- `captured_at`, `created_at`, `completed_at` dùng UTC chính xác dạng `YYYY-MM-DDTHH:mm:ss.SSSZ`. Đơn completed bắt buộc có `completed_at`, không trước ngày tạo hay sau thời điểm snapshot.
- Mỗi dòng hàng bắt buộc có `unit_cost`, kể cả giá vốn bằng 0. Không tự suy đoán giá vốn từ giá bán hoặc giá nhập hiện tại.
- Tối đa 1000 sản phẩm, 1000 đơn, 100 mặt hàng mỗi đơn và body 2 MB. ID nguyên dương, tồn kho không âm, không trùng sản phẩm trong đơn hay trùng ID trong mỗi danh sách.
- Snapshot mới thay thế nguyên khối trong một transaction; lỗi ghi sẽ rollback toàn bộ. Khóa hàng metadata tuần tự hóa các lần đồng bộ đồng thời.
- Gửi lại cùng snapshot, cùng thời gian và nội dung chuẩn hóa trả `applied: false`. Snapshot cũ hoặc cùng thời gian nhưng khác dữ liệu trả `409`.
- Báo cáo đọc trong transaction `REPEATABLE READ`, giữ metadata và số liệu thuộc cùng một snapshot khi có đồng bộ đồng thời.

**Tích hợp với dịch vụ hiện có:** mã nguồn Order Service hiện chỉ lưu `unit_price`, chưa lưu giá vốn hay thời điểm hoàn thành riêng; Product Service chưa có trong repository. Vì vậy việc lấy dữ liệu tự động từ các dịch vụ nguồn chưa được cấu hình. Bên nguồn hoặc một tiến trình tích hợp cần bổ sung `unit_cost` chốt tại thời điểm bán và `completed_at`, rồi gửi snapshot đúng hợp đồng trên. Không thay `unit_cost` bằng giá nhập hiện tại vì sẽ làm thay đổi lợi nhuận lịch sử. API đồng bộ đã sẵn sàng nhận dữ liệu; file ví dụ giúp chạy thử độc lập.

## Kiểm thử

```powershell
npm test
# Nếu môi trường hạn chế tạo tiến trình con:
node --test --test-isolation=none
```

Integration test mặc định được bỏ qua. Để kiểm tra báo cáo với MySQL thật, tạo database rỗng `report_service_test`, cấp quyền tương tự trên và chạy trong PowerShell:

```powershell
$env:REPORT_DB_NAME = 'report_service_test'
$env:REPORT_MYSQL_INTEGRATION = '1'
node --env-file-if-exists=.env --test --test-isolation=none test/report.mysql.integration.test.js
Remove-Item Env:REPORT_DB_NAME
Remove-Item Env:REPORT_MYSQL_INTEGRATION
```

Test yêu cầu tên DB kết thúc bằng `_test` và chưa có snapshot/dữ liệu; kiểm tra giá vốn, lỗ, đơn hủy/chờ, sản phẩm chưa bán/đã xóa, cận ngày, gửi lại snapshot, xóa/sửa dữ liệu và rollback khi SQL lỗi.
