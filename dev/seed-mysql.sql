-- Demo data for Celer's MySQL / MariaDB driver.
-- Load with:  powershell -ExecutionPolicy Bypass -File dev\testdb-mysql.ps1 seed
-- (or: mariadb -h 127.0.0.1 -P 33069 -u root -pceler < dev\seed-mysql.sql)
-- Idempotent: drops and recreates the `celer` and `shop` databases.

SET NAMES utf8mb4;

CREATE USER IF NOT EXISTS 'celer'@'%' IDENTIFIED BY 'celer';
CREATE USER IF NOT EXISTS 'celer'@'localhost' IDENTIFIED BY 'celer';
GRANT ALL PRIVILEGES ON *.* TO 'celer'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'celer'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;

DROP DATABASE IF EXISTS celer;
DROP DATABASE IF EXISTS shop;
CREATE DATABASE celer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE celer;

-- ---------------------------------------------------------------- customers
CREATE TABLE customers (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    email         VARCHAR(190) NOT NULL,
    full_name     VARCHAR(120) NOT NULL,
    country       CHAR(2)      NOT NULL DEFAULT 'ES',
    tier          ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    credit_limit  DECIMAL(12,2) NULL,
    prefs         JSON NULL,
    avatar        BLOB NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_customers_email (email),
    KEY ix_customers_country (country, tier)
) ENGINE=InnoDB COMMENT='Clientes de demo';

INSERT INTO customers (email, full_name, country, tier, is_active, credit_limit, prefs, avatar, created_at) VALUES
('ana.garcia@example.com',   'Ana García',        'ES', 'pro',        1, 5000.00,  '{"lang":"es","theme":"dark","news":true}',  X'89504E470D0A1A0A', '2024-01-15 09:30:00'),
('bruno.silva@example.com',  'Bruno Silva',       'PT', 'free',       1, NULL,     '{"lang":"pt"}',                            NULL,                '2024-02-03 17:05:12'),
('chloe.martin@example.com', 'Chloé Martin',      'FR', 'enterprise', 1, 250000.50,'{"lang":"fr","seats":42}',                 NULL,                '2023-11-20 08:00:00'),
('dieter.k@example.com',     'Dieter Köhler',     'DE', 'pro',        0, 1200.00,  NULL,                                       X'DEADBEEF',         '2022-06-30 23:59:59'),
('emma.jones@example.com',   'Emma Jones',        'GB', 'free',       1, 0.00,     '{"lang":"en","tags":["vip","beta"]}',       NULL,                '2024-05-01 12:00:00'),
('fatima.z@example.com',     'Fátima Zahra',      'MA', 'pro',        1, 750.25,   '{}',                                       NULL,                '2024-07-14 14:14:14'),
('giulia.r@example.com',     'Giulia Rossi',      'IT', 'free',       1, NULL,     NULL,                                       NULL,                '2025-01-02 10:10:10'),
('hiro.tanaka@example.com',  'Hiro Tanaka 田中',  'JP', 'enterprise', 1, 99999.99, '{"lang":"ja"}',                            NULL,                '2023-03-03 03:03:03');

-- ---------------------------------------------------------------- products
CREATE TABLE products (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku         VARCHAR(32)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    price       DECIMAL(10,2) NOT NULL,
    stock       INT UNSIGNED NOT NULL DEFAULT 0,
    weight_kg   FLOAT NULL,
    attrs       JSON NULL,
    released_on DATE NULL,
    UNIQUE KEY uq_products_sku (sku),
    FULLTEXT KEY ft_products_name (name)
) ENGINE=InnoDB;

INSERT INTO products (sku, name, price, stock, weight_kg, attrs, released_on) VALUES
('KB-001', 'Teclado mecánico',       89.90, 120, 0.95, '{"layout":"ES","switch":"brown"}', '2023-09-01'),
('MS-002', 'Ratón inalámbrico',      29.99, 340, 0.11, '{"dpi":1600}',                     '2022-04-12'),
('MN-027', 'Monitor 27" 4K',        349.00,  25, 6.40, '{"hz":144,"panel":"IPS"}',          '2024-02-20'),
('HD-512', 'SSD NVMe 512 GB',        54.50, 800, 0.01, NULL,                               '2021-11-11'),
('CB-USB', 'Cable USB-C 2 m',         7.95, 2000, 0.05, '{"color":"black"}',               NULL),
('DK-100', 'Dock Thunderbolt',      219.00,   0, 0.70, '{"ports":11}',                     '2024-10-01');

-- ---------------------------------------------------------------- orders
CREATE TABLE orders (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id INT UNSIGNED NOT NULL,
    ordered_at  DATETIME(3)  NOT NULL,
    status      ENUM('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
    total       DECIMAL(12,2) NOT NULL DEFAULT 0,
    notes       TEXT NULL,
    KEY ix_orders_customer_date (customer_id, ordered_at),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE order_items (
    order_id   INT UNSIGNED NOT NULL,
    product_id INT UNSIGNED NOT NULL,
    qty        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    PRIMARY KEY (order_id, product_id),
    KEY ix_items_product (product_id),
    CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders (id)   ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB;

DELIMITER //
CREATE TRIGGER trg_order_items_ai AFTER INSERT ON order_items
FOR EACH ROW
BEGIN
    UPDATE orders SET total = total + NEW.qty * NEW.unit_price WHERE id = NEW.order_id;
END //

CREATE FUNCTION fn_order_total(p_order_id INT UNSIGNED) RETURNS DECIMAL(12,2)
    READS SQL DATA
BEGIN
    DECLARE v DECIMAL(12,2);
    SELECT COALESCE(SUM(qty * unit_price), 0) INTO v FROM order_items WHERE order_id = p_order_id;
    RETURN v;
END //

CREATE PROCEDURE sp_orders_by_customer(IN p_customer_id INT UNSIGNED)
    READS SQL DATA
BEGIN
    SELECT o.id, o.ordered_at, o.status, o.total, fn_order_total(o.id) AS computed_total
    FROM orders o
    WHERE o.customer_id = p_customer_id
    ORDER BY o.ordered_at;
END //
DELIMITER ;

INSERT INTO orders (customer_id, ordered_at, status, notes) VALUES
(1, '2024-03-01 10:00:00.123', 'paid',      'Entrega por la mañana'),
(1, '2024-04-11 18:22:05.000', 'shipped',   NULL),
(2, '2024-04-12 09:15:00.500', 'new',       NULL),
(3, '2024-05-20 11:11:11.111', 'paid',      'Factura a nombre de la empresa'),
(5, '2024-06-02 16:45:00.000', 'cancelled', 'Cliente canceló; "duplicado"'),
(8, '2025-01-07 07:07:07.007', 'paid',      NULL);

INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES
(1, 1, 1, 89.90), (1, 2, 2, 29.99),
(2, 4, 3, 54.50),
(3, 5, 10, 7.95),
(4, 3, 4, 349.00), (4, 6, 4, 219.00),
(5, 2, 1, 29.99),
(6, 1, 2, 89.90), (6, 3, 1, 349.00);

CREATE VIEW v_customer_orders AS
SELECT c.id AS customer_id, c.full_name, c.country, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS total_spent,
       MAX(o.ordered_at) AS last_order
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
GROUP BY c.id, c.full_name, c.country;

-- ---------------------------------------------------------------- type zoo
CREATE TABLE type_zoo (
    id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    c_tinyint   TINYINT NULL,
    c_bool      BOOLEAN NULL,
    c_smallint  SMALLINT NULL,
    c_mediumint MEDIUMINT NULL,
    c_int       INT NULL,
    c_bigint    BIGINT NULL,
    c_ubigint   BIGINT UNSIGNED NULL,
    c_float     FLOAT NULL,
    c_double    DOUBLE NULL,
    c_decimal   DECIMAL(30,10) NULL,
    c_bit       BIT(8) NULL,
    c_char      CHAR(5) NULL,
    c_varchar   VARCHAR(100) NULL,
    c_text      TEXT NULL,
    c_binary    BINARY(4) NULL,
    c_varbinary VARBINARY(16) NULL,
    c_blob      BLOB NULL,
    c_date      DATE NULL,
    c_time      TIME(3) NULL,
    c_datetime  DATETIME(6) NULL,
    c_timestamp TIMESTAMP NULL DEFAULT NULL,
    c_year      YEAR NULL,
    c_json      JSON NULL,
    c_enum      ENUM('red','green','blue') NULL,
    c_set       SET('a','b','c') NULL,
    c_uuid      UUID NULL
) ENGINE=InnoDB;

INSERT INTO type_zoo (c_tinyint, c_bool, c_smallint, c_mediumint, c_int, c_bigint, c_ubigint, c_float, c_double, c_decimal,
                      c_bit, c_char, c_varchar, c_text, c_binary, c_varbinary, c_blob, c_date, c_time, c_datetime, c_timestamp,
                      c_year, c_json, c_enum, c_set, c_uuid) VALUES
(-128, TRUE, -32768, -8388608, -2147483648, -9223372036854775808, 18446744073709551615, 1.5, 3.141592653589793,
 '12345678901234567890.0123456789', b'10100101', 'abc', 'hola mundo', 'texto largo…', X'00FF10AB', X'CAFEBABE', X'0102030405',
 '2024-02-29', '-838:59:59.000', '2024-12-31 23:59:59.999999', '2024-06-15 12:30:45', 2024, '{"a":[1,2,3],"b":null}', 'green', 'a,c',
 '123e4567-e89b-12d3-a456-426614174000'),
(127, FALSE, 32767, 8388607, 2147483647, 9007199254740993, 42, -0.25, -1e300, '-0.0000000001', b'1', 'x', '', '', X'00000000', X'',
 X'', '1970-01-01', '12:00:00.5', '2000-01-01 00:00:00', '2038-01-19 03:14:07', 1999, '[]', 'red', '', NULL),
(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
 NULL, NULL, NULL, NULL, NULL);

-- ---------------------------------------------------------------- big table (200k rows) for paging
CREATE TABLE events (
    id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    happened  DATETIME NOT NULL,
    kind      VARCHAR(20) NOT NULL,
    user_id   INT UNSIGNED NULL,
    amount    DECIMAL(10,2) NULL,
    score     DOUBLE NULL,
    payload   JSON NULL,
    KEY ix_events_kind_time (kind, happened)
) ENGINE=InnoDB;

INSERT INTO events (id, happened, kind, user_id, amount, score, payload)
SELECT n,
       TIMESTAMPADD(SECOND, n * 37, '2024-01-01 00:00:00'),
       ELT(1 + (n % 5), 'login', 'logout', 'purchase', 'view', 'error'),
       IF(n % 11 = 0, NULL, 1 + (n % 8)),
       IF(n % 5 = 2, ROUND((n % 1000) * 1.37, 2), NULL),
       (n % 997) / 7.0,
       IF(n % 3 = 0, JSON_OBJECT('n', n, 'even', n % 2 = 0), NULL)
FROM (
    SELECT 1 + a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + g.d * 100000 AS n
    FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
    CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
    CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
    CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e
    CROSS JOIN (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
          UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) f
    CROSS JOIN (SELECT 0 d UNION ALL SELECT 1) g
) seq;

ANALYZE TABLE customers, products, orders, order_items, type_zoo, events;

-- ---------------------------------------------------------------- shop
USE shop;

CREATE TABLE categories (
    id        SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    parent_id SMALLINT UNSIGNED NULL,
    name      VARCHAR(80) NOT NULL,
    slug      VARCHAR(80) NOT NULL UNIQUE,
    CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
) ENGINE=InnoDB;

CREATE TABLE items (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    category_id SMALLINT UNSIGNED NOT NULL,
    title       VARCHAR(150) NOT NULL,
    price       DECIMAL(8,2) NOT NULL,
    available   BOOLEAN NOT NULL DEFAULT TRUE,
    added       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_items_category (category_id),
    CONSTRAINT fk_items_category FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB;

INSERT INTO categories (id, parent_id, name, slug) VALUES
(1, NULL, 'Informática', 'informatica'), (2, 1, 'Portátiles', 'portatiles'), (3, 1, 'Periféricos', 'perifericos'),
(4, NULL, 'Hogar', 'hogar'), (5, 4, 'Cocina', 'cocina');

INSERT INTO items (category_id, title, price, available, added) VALUES
(2, 'Portátil 14" 16 GB', 999.00, TRUE, '2024-03-10 10:00:00'),
(2, 'Portátil 16" 32 GB', 1599.00, FALSE, '2024-03-11 10:00:00'),
(3, 'Webcam 1080p', 49.90, TRUE, '2024-04-01 09:00:00'),
(5, 'Cafetera espresso', 189.00, TRUE, '2024-05-05 15:30:00'),
(5, 'Tostadora', 24.99, TRUE, '2024-05-06 15:30:00');

CREATE VIEW v_items_with_category AS
SELECT i.id, i.title, i.price, c.name AS category, p.name AS parent_category
FROM items i
JOIN categories c ON c.id = i.category_id
LEFT JOIN categories p ON p.id = c.parent_id;
