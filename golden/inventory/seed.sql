-- Inventory sample records. Applied once, after the schema, as the "Seed sample data" migration.
INSERT INTO suppliers (id, name, email, phone, lead_time_days) VALUES
  (1, 'Northwind Supply', 'orders@northwind.example', '555-1100', 5),
  (2, 'Contoso Parts', 'sales@contoso.example', '555-2200', 10),
  (3, 'Fabrikam Tools', 'trade@fabrikam.example', '555-3300', 14);

INSERT INTO locations (id, code, name, kind) VALUES
  (1, 'WH1', 'Main warehouse', 'warehouse'),
  (2, 'ST1', 'Downtown store', 'store'),
  (3, 'ST2', 'Airport store', 'store');

INSERT INTO products (id, sku, name, supplier_id, unit_cost, unit, active) VALUES
  (1, 'BOLT-M8', 'Hex bolt M8', 2, 0.25, 'each', 1),
  (2, 'NUT-M8', 'Hex nut M8', 2, 0.10, 'each', 1),
  (3, 'DRILL-18V', 'Cordless drill 18V', 3, 89.00, 'each', 1),
  (4, 'GLOVE-L', 'Work gloves (L)', 1, 4.50, 'pair', 1),
  (5, 'TAPE-25', 'Measuring tape 25ft', 3, 12.00, 'each', 1),
  (6, 'LADDER-6', 'Step ladder 6ft', 1, 65.00, 'each', 1);

INSERT INTO stock_movements (id, product_id, location_id, quantity, kind, reference, moved_on, note) VALUES
  (1, 1, 1, 1000, 'receipt', 'PO-1001', '2026-09-01', NULL),
  (2, 2, 1, 1500, 'receipt', 'PO-1001', '2026-09-01', NULL),
  (3, 3, 1, 20, 'receipt', 'PO-1002', '2026-09-02', NULL),
  (4, 4, 1, 200, 'receipt', 'PO-1003', '2026-09-02', NULL),
  (5, 5, 1, 40, 'receipt', 'PO-1002', '2026-09-02', NULL),
  (6, 6, 1, 8, 'receipt', 'PO-1003', '2026-09-03', NULL),
  (7, 1, 2, 200, 'receipt', 'PO-1004', '2026-09-04', NULL),
  (8, 3, 2, 5, 'receipt', 'PO-1004', '2026-09-04', NULL),
  (9, 4, 2, 30, 'receipt', 'PO-1005', '2026-09-04', NULL),
  (10, 5, 2, 10, 'receipt', 'PO-1005', '2026-09-04', NULL),
  (11, 4, 3, 15, 'receipt', 'PO-1006', '2026-09-05', NULL),
  (12, 5, 3, 6, 'receipt', 'PO-1006', '2026-09-05', NULL),
  (13, 1, 2, -150, 'issue', 'SO-2001', '2026-09-10', 'Contractor order'),
  (14, 3, 2, -3, 'issue', 'SO-2002', '2026-09-11', NULL),
  (15, 2, 1, -300, 'issue', 'SO-2003', '2026-09-12', NULL),
  (16, 4, 3, -12, 'issue', 'SO-2004', '2026-09-12', NULL),
  (17, 6, 1, -6, 'issue', 'SO-2005', '2026-09-13', NULL),
  (18, 5, 2, -9, 'issue', 'SO-2006', '2026-09-14', NULL);

INSERT INTO reorder_thresholds (product_id, location_id, min_quantity, reorder_quantity) VALUES
  (1, 1, 200, 1000),
  (1, 2, 100, 500),
  (2, 1, 500, 1000),
  (3, 2, 3, 5),
  (4, 3, 5, 20),
  (5, 2, 2, 10),
  (6, 1, 2, 4);

INSERT INTO transfers (id, product_id, from_location_id, to_location_id, quantity, status, requested_on, posted_on) VALUES
  (1, 1, 1, 2, 200, 'draft', '2026-09-20', NULL);
