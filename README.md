# Dịch vụ quản lý đơn hàng — Node.js + MySQL

Order Service độc lập tại **http://localhost:3002**, database MySQL riêng `order_service`. Dùng Node.js 22+, Express 5, mysql2 và MySQL 8.0.16+ (khuyến nghị 8.4). Không truy vấn database của Auth Service hoặc Product Service.

## Cài đặt và chạy

```powershell
npm install
Copy-Item .env.example .env
```

Sửa `.env` theo MySQL, Auth Service bài 2 và Product Service thực tế. Không commit `.env`.

**Cách 1 — MySQL bằng Docker:** mở Docker Desktop rồi chạy:

```powershell
docker compose up -d --wait
npm run db:init
npm start
```

Compose tạo database, tài khoản và schema khi volume được khởi tạo lần đầu. `db:init` cũng có thể chạy lại để tạo các bảng còn thiếu; không phải công cụ migration cho schema đã thay đổi. Nếu cổng 3306 đang được dùng, đổi cổng bên trái trong Compose và `DB_PORT` trong `.env`.

**Cách 2 — MySQL có sẵn:** chạy SQL sau bằng tài khoản quản trị, rồi chỉnh thông tin kết nối trong `.env`:

```sql
CREATE DATABASE order_service CHARACTER SET utf8mb4;
CREATE USER 'order_user'@'localhost' IDENTIFIED BY 'order_password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES ON order_service.* TO 'order_user'@'localhost';
```

```powershell
npm run db:init
npm start
```

Kiểm tra kết nối MySQL qua `GET /health`. Endpoint này không cần token và không kiểm tra tình trạng hai service bên ngoài.

## Kết nối các service

Các URL dưới đây là **giả định cấu hình**, cần khớp API của bài trước.

### Auth Service

`AUTH_VERIFY_URL=http://localhost:3000/auth/verify`

Mọi API đơn hàng và chi tiết đơn hàng nhận `Authorization: Bearer <access_token>`. Middleware chuyển nguyên header này qua `GET AUTH_VERIFY_URL`. Auth Service phải trả 2xx và JSON một trong các dạng:

```json
{"valid":true,"user":{"id":1}}
```

Hỗ trợ thêm `{ "active": true }`, `{ "user": { "id": 1 } }`, `{ "id": 1 }` và envelope `{ "data": ... }`. Token bị từ chối trả 401/403; không kết nối được Auth Service trả 503. Không có cơ chế bỏ qua xác thực. Nếu bài 2 dùng POST hoặc cấu trúc khác, sửa adapter `authenticate` trong `src/clients.js`. Service này xác thực token theo yêu cầu bài tập; chưa có phân quyền sở hữu đơn hàng theo người dùng.

### Product Service

`PRODUCT_SERVICE_URL=http://localhost:3001`

Gọi `GET /products/:id` với cùng Bearer token, ví dụ phản hồi:

```json
{"id":1,"name":"Bàn phím","price":"250000.00","stock":10}
```

Hỗ trợ `quantity` thay `stock`, envelope `{ "data": ... }` hoặc `{ "product": ... }`. Tên và giá lấy từ service, bỏ qua giá/tổng tiền do client gửi lên. Nếu cấu trúc thực tế khác, sửa adapter `product` trong `src/clients.js`. Timeout mỗi request mặc định 5 giây.

**Phạm vi tồn kho:** kiểm tra khi tạo đơn, thêm/sửa mặt hàng và chuyển sang `completed`. API sản phẩm hiện chưa được cung cấp nên service chỉ đọc tồn kho, chưa giữ chỗ hay trừ/hoàn kho. Hai đơn đồng thời vẫn có thể cùng vượt qua kiểm tra. Để bảo đảm không bán vượt kho, cần Product Service cung cấp thao tác reserve/commit/release nguyên tử và cơ chế Saga/idempotency giữa các service.

## REST API

Tất cả endpoint dưới đây đều yêu cầu Bearer token.

| Method | Endpoint | Chức năng |
|---|---|---|
| GET | `/orders` | Danh sách đơn hàng |
| GET | `/orders/:id` | Chi tiết đơn, bao gồm `items` |
| POST | `/orders` | Tạo đơn kèm mặt hàng, kiểm tra tồn kho |
| PUT | `/orders/:id` | Cập nhật trạng thái |
| DELETE | `/orders/:id` | Xóa đơn và tự động xóa mặt hàng liên quan |
| GET | `/order_items` | Tất cả mặt hàng; lọc bằng `?order_id=1` |
| GET | `/order_items/:id` | Chi tiết mặt hàng |
| POST | `/order_items` | Thêm sản phẩm vào đơn pending |
| PUT | `/order_items/:id` | Sửa quantity, tùy chọn đổi product_id |
| DELETE | `/order_items/:id` | Xóa mặt hàng của đơn pending |

### Tạo đơn hàng

```http
POST /orders
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "customer_name": "Nguyễn Văn An",
  "customer_email": "an@example.com",
  "items": [
    { "product_id": 1, "quantity": 2 },
    { "product_id": 2, "quantity": 1 }
  ]
}
```

Đơn mới mặc định `pending`. Cần 1–100 mặt hàng, mỗi sản phẩm xuất hiện một lần. Muốn thêm số lượng sản phẩm đã có, dùng PUT mặt hàng.

### Cập nhật trạng thái

```http
PUT /orders/1
Authorization: Bearer <access_token>
Content-Type: application/json

{"status":"completed"}
```

Luồng: `pending → completed` hoặc `pending → cancelled`. Cho phép gửi lại trạng thái hiện tại. Đơn completed/cancelled không thể chuyển trạng thái khác hoặc sửa mặt hàng. Không thể hoàn thành đơn rỗng.

### Thêm và cập nhật chi tiết

```http
POST /order_items
Authorization: Bearer <access_token>
Content-Type: application/json

{"order_id":1,"product_id":3,"quantity":2}
```

```http
PUT /order_items/1
Authorization: Bearer <access_token>
Content-Type: application/json

{"quantity":3}
```

PUT cũng nhận `product_id` để đổi sản phẩm; không được đổi `order_id`. Khi chỉ đổi số lượng, giữ nguyên tên/giá đã chụp lúc đặt hàng. Khi đổi sản phẩm, lấy tên/giá mới. Xóa hết mặt hàng khiến tổng đơn bằng `0.00`.

### Gọi từ PowerShell

```powershell
$headers = @{ Authorization = 'Bearer YOUR_ACCESS_TOKEN' }
$body = @{
  customer_name = 'Nguyễn Văn An'
  customer_email = 'an@example.com'
  items = @(@{ product_id = 1; quantity = 2 })
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:3002/orders -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod -Uri http://localhost:3002/orders -Headers $headers
```

Phản hồi thành công có dạng `{ "data": ... }`; POST trả 201 kèm `Location`; DELETE trả 204 không có body. Giá và tổng tiền là chuỗi thập phân như `"500000.00"`, giữ đúng độ chính xác. Lỗi có dạng `{ "error": { "message": "..." } }`.

| HTTP | Ý nghĩa |
|---|---|
| 400 | Input/JSON/ID không hợp lệ hoặc tổng tiền vượt DECIMAL(10,2) |
| 401/403 | Thiếu/sai token hoặc không đủ quyền theo service bên ngoài |
| 404 | Không tìm thấy đơn, mặt hàng hoặc sản phẩm |
| 409 | Thiếu tồn kho, sản phẩm trùng, trạng thái không cho phép hoặc xung đột cập nhật |
| 413 | JSON body quá 128 KB |
| 502 | Service bên ngoài trả lỗi hoặc dữ liệu không đúng hợp đồng |
| 503 | Service bên ngoài không kết nối được hoặc timeout |

## Dữ liệu và tính nhất quán

Schema tại `sql/schema.sql`: `orders` và `order_items` (sửa lỗi tên `other_items` trong phụ lục). `order_id` là khóa ngoại `ON DELETE CASCADE`; `product_id` chỉ lưu ID ngoài service, không có khóa ngoại sang database sản phẩm. Cặp `(order_id, product_id)` duy nhất. `total_price` là cột MySQL tự tính `quantity * unit_price`.

Controller dùng SQL có tham số, transaction và `SELECT ... FOR UPDATE` trên đơn khi sửa để tránh mất cập nhật tổng tiền. Nếu thao tác thất bại, transaction rollback. Tổng đơn được tính từ các mặt hàng, dùng số nguyên đơn vị xu và kiểm tra giới hạn `DECIMAL(10,2)`.

## Kiểm thử

```powershell
npm test
```

Chạy unit/HTTP tests cho xác thực, validation, tiền tệ, lỗi service và vòng đời transaction. Bài test MySQL được skip mặc định, vì cần MySQL thật.

Để kiểm thử tích hợp, tạo database riêng, cấp quyền tài khoản như trên và chạy:

```sql
CREATE DATABASE order_service_test CHARACTER SET utf8mb4;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES ON order_service_test.* TO 'order_user'@'localhost';
```

```powershell
$env:DB_NAME = 'order_service_test'
$env:MYSQL_INTEGRATION = '1'
node --env-file-if-exists=.env --test
Remove-Item Env:DB_NAME
Remove-Item Env:MYSQL_INTEGRATION
```

Integration test dùng MySQL thật, mô phỏng phản hồi Auth/Product Service trong adapter; kiểm tra CRUD, số tiền, rollback khi thiếu kho, cập nhật đồng thời, chuyển trạng thái và cascade. Chỉ cho phép database kết thúc bằng `_test` và dọn các đơn do bài test tạo.

## Cấu trúc

```text
src/
  app.js                 Routes, middleware xác thực và xử lý lỗi
  server.js              Kết nối DB, khởi động HTTP, shutdown
  config.js              Đọc cấu hình môi trường
  db.js                  Pool MySQL và transaction
  clients.js             HTTP adapters cho Auth/Product Service
  validation.js          Kiểm tra input và tiền tệ
  errors.js              Lỗi HTTP nghiệp vụ
  controllers/orders.js  Nghiệp vụ orders và order_items
sql/schema.sql           Schema database riêng
scripts/init-db.js       Khởi tạo bảng
test/                    Unit/HTTP và MySQL integration tests
```

Tài liệu tham khảo: [Express — error handling](https://expressjs.com/en/5x/guide/error-handling/), [mysql2 — Promise pool](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool).
