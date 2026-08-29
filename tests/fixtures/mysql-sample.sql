-- Sample dump: a small storefront schema with relationships.

CREATE TABLE `customers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `first_name` varchar(80) NOT NULL,
  `last_name` varchar(80) NOT NULL,
  `email` varchar(255) NOT NULL,
  `country` varchar(2) DEFAULT 'US',
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `customers_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `customers` VALUES
(1,'John','Doe','john@example.com','US','2024-01-04 10:00:00'),
(2,'Jane','Smith','jane@example.com','GB','2024-01-06 14:30:00'),
(3,'Bob','Johnson','bob@example.com','US','2024-02-11 09:15:00'),
(4,'Alice','Williams','alice@example.com','DE','2024-02-19 16:45:00'),
(5,'Charlie','Brown','charlie@example.com','US','2024-03-02 11:20:00');

CREATE TABLE `categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(80) NOT NULL,
  `parent_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `categories_parent` FOREIGN KEY (`parent_id`) REFERENCES `categories` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `categories` VALUES (1,'Hardware',NULL),(2,'Peripherals',1),(3,'Displays',1);

CREATE TABLE `products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `category_id` int(11) NOT NULL,
  `name` varchar(160) NOT NULL,
  `price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `stock` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `products_category` (`category_id`),
  CONSTRAINT `products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `products` VALUES
(1,2,'Wireless Mouse',19.99,200),
(2,2,'Mechanical Keyboard',89.50,150),
(3,3,'27" 4K Monitor',299.99,75),
(4,1,'Laptop Stand, aluminium',49.00,60),
(5,1,'USB-C Dock',129.95,40);

CREATE TABLE `orders` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) NOT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'pending',
  `total` decimal(10,2) NOT NULL,
  `placed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `orders_customer` (`customer_id`),
  CONSTRAINT `orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `orders` VALUES
(1001,1,'shipped',309.98,'2024-03-01 12:04:00'),
(1002,2,'pending',89.50,'2024-03-03 08:22:00'),
(1003,1,'shipped',49.00,'2024-03-05 17:41:00'),
(1004,4,'cancelled',129.95,'2024-03-09 19:03:00'),
(1005,5,'shipped',339.97,'2024-03-12 10:12:00');

CREATE TABLE `order_items` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `quantity` int(11) NOT NULL DEFAULT '1',
  `unit_price` decimal(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `order_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `order_items` (`id`,`order_id`,`product_id`,`quantity`,`unit_price`) VALUES
(1,1001,1,1,19.99),(2,1001,3,1,289.99),(3,1002,2,1,89.50),(4,1003,4,1,49.00),
(5,1004,5,1,129.95),(6,1005,3,1,299.99),(7,1005,1,2,19.99);

CREATE TABLE `reviews` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `rating` tinyint(4) NOT NULL,
  `body` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `reviews` VALUES
(1,1,1,5,'Great mouse - it''s light and the battery lasts.'),
(2,3,5,4,'Sharp panel.\nStand is wobbly, though.'),
(3,2,2,3,NULL);

ALTER TABLE `reviews`
  ADD CONSTRAINT `reviews_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  ADD CONSTRAINT `reviews_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`);
