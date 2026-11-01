-- LOCAL VALIDATION DATABASE ONLY. Never run against hosted D1.
INSERT INTO suppliers VALUES('fixture-s1','Fixture A','https://example.com','Indian wholesaler','Paused','{}',NULL);
INSERT INTO suppliers VALUES('fixture-s2','Fixture B','https://example.org','Indian wholesaler','Paused','{}',NULL);
INSERT INTO groups VALUES('fixture-g1','Goku figure','Unmatched','2026-11-01T00:00:00Z');
INSERT INTO groups VALUES('fixture-g2','Goku figure','Unmatched','2026-11-01T00:00:00Z');
INSERT INTO listings VALUES('fixture-l1','fixture-s1','fixture-g1','https://example.com/goku','Goku figure',NULL,20,'PVC',450,'INR','In stock','NEW','{"name":"Goku figure","offers":{"price":450}}','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
INSERT INTO listings VALUES('fixture-l2','fixture-s2','fixture-g2','https://example.org/goku','Goku figure',NULL,20,'PVC',520,'INR','Unknown','NEW','{"name":"Goku figure","offers":{"price":520}}','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
INSERT INTO history VALUES('fixture-history','fixture-l1','2026-11-01T00:00:00Z','PRICE UPDATED','{"offers":{"price":500}}','{"offers":{"price":450}}');
INSERT INTO reviews VALUES('fixture-review','fixture-l2','fixture-g1',0.9,'Fixture match requiring approval','Pending');
