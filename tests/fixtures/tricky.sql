-- A dump full of things that break naive parsers.
-- Note: this comment has an apostrophe -- it's here, and a semicolon; too.
/* A block comment
   spanning lines with 'quotes' and ; semicolons */

DROP TABLE IF EXISTS `weird`;
CREATE TABLE `weird` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `label` varchar(255) NOT NULL DEFAULT 'n/a',
  `note` text COMMENT 'a comment, with comma',
  `amount` decimal(12,2) DEFAULT '0.00',
  `flag` tinyint(1) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `label_idx` (`label`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `weird` VALUES
(1,'plain','simple text',10.50,1),
(2,'comma','text, with, commas',0.00,0),
(3,'semi','ends with; semicolon',1.25,NULL),
(4,'paren','nested (parens) inside',99.99,1),
(5,'quote','it''s doubled',3.00,0),
(6,'escape','back\slash and \'escaped\' quote',4.20,1),
(7,'newline','line one\nline two',5.00,0),
(8,'unicode','héllo wörld ünïcode',6.00,1),
(9,'empty','',7.00,NULL),
(10,'nullish',NULL,8.00,0);

CREATE TABLE `child` (
  `id` int NOT NULL,
  `weird_id` int NOT NULL,
  `tag` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
);

INSERT INTO `child` (`id`,`weird_id`,`tag`) VALUES (1,1,'a'),(2,2,'b');
INSERT INTO `child` (`tag`,`id`,`weird_id`) VALUES ('c',3,3);

ALTER TABLE `child`
  ADD CONSTRAINT `child_weird` FOREIGN KEY (`weird_id`) REFERENCES `weird` (`id`) ON DELETE CASCADE;
