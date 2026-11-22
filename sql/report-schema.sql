CREATE TABLE IF NOT EXISTS report_snapshot (
  id TINYINT NOT NULL PRIMARY KEY,
  captured_at DATETIME(3) NULL,
  content_hash CHAR(64) NULL,
  CHECK (id = 1)
) ENGINE=InnoDB;

INSERT IGNORE INTO report_snapshot (id) VALUES (1);

CREATE TABLE IF NOT EXISTS report_products (
  product_id INT NOT NULL PRIMARY KEY,
  product_name VARCHAR(255) NOT NULL,
  stock INT NOT NULL,
  CHECK (product_id > 0),
  CHECK (stock >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_orders (
  order_id INT NOT NULL PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  INDEX idx_report_completed (status, completed_at),
  CHECK (status IN ('pending', 'completed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_items (
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  INDEX idx_report_product (product_id),
  FOREIGN KEY (order_id) REFERENCES report_orders(order_id) ON DELETE CASCADE,
  CHECK (quantity > 0),
  CHECK (unit_price >= 0),
  CHECK (unit_cost >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
