CREATE TABLE IF NOT EXISTS orders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_order_status CHECK (status IN ('pending', 'completed', 'cancelled')),
  CONSTRAINT chk_order_amount CHECK (total_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT uq_order_product UNIQUE (order_id, product_id),
  CONSTRAINT chk_item_quantity CHECK (quantity > 0),
  CONSTRAINT chk_item_price CHECK (unit_price >= 0),
  CONSTRAINT chk_product_id CHECK (product_id > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
