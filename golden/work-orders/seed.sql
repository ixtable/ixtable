-- Work-order sample records. Applied once, after the schema, as the "Seed sample data" migration.
INSERT INTO statuses (code, name, position, is_final) VALUES
  ('open', 'Open', 1, 0),
  ('in_progress', 'In progress', 2, 0),
  ('done', 'Done', 3, 1),
  ('cancelled', 'Cancelled', 4, 1);

INSERT INTO priorities (code, name, rank) VALUES
  ('low', 'Low', 1),
  ('normal', 'Normal', 2),
  ('high', 'High', 3),
  ('urgent', 'Urgent', 4);

INSERT INTO assignees (id, name, email, team, active) VALUES
  (1, 'Maria Lopez', 'maria@plant.example', 'Mechanical', 1),
  (2, 'Tom Chen', 'tom@plant.example', 'Electrical', 1),
  (3, 'Priya Nair', 'priya@plant.example', 'Facilities', 1);

INSERT INTO assets (id, tag, name, location, category, installed_on) VALUES
  (1, 'PUMP-001', 'Coolant pump', 'Plant A', 'Mechanical', '2019-04-01'),
  (2, 'HVAC-002', 'Rooftop HVAC unit', 'Building 1', 'HVAC', '2020-06-15'),
  (3, 'CONV-003', 'Conveyor line 3', 'Plant A', 'Mechanical', '2018-11-20'),
  (4, 'GEN-004', 'Backup generator', 'Yard', 'Electrical', '2021-02-10');

INSERT INTO work_orders (id, number, asset_id, title, description, status_code, priority_code, assignee_id, opened_on, started_on, completed_on, progress) VALUES
  (1, 'WO-1001', 1, 'Replace pump seal', 'Seal is weeping coolant.', 'in_progress', 'high', 1, '2026-09-01', '2026-09-02', NULL, 50),
  (2, 'WO-1002', 2, 'Quarterly HVAC service', NULL, 'open', 'normal', 3, '2026-09-05', NULL, NULL, 0),
  (3, 'WO-1003', 3, 'Belt alignment', NULL, 'done', 'normal', 1, '2026-08-20', '2026-08-21', '2026-08-22', 100),
  (4, 'WO-1004', 4, 'Load test generator', 'Annual load bank test.', 'open', 'urgent', 2, '2026-09-10', NULL, NULL, 0),
  (5, 'WO-1005', 1, 'Vibration inspection', NULL, 'open', 'low', NULL, '2026-09-12', NULL, NULL, 0);

INSERT INTO tasks (id, work_order_id, position, description, done, hours) VALUES
  (1, 1, 1, 'Drain coolant', 1, 1.5),
  (2, 1, 2, 'Remove old seal', 1, 2),
  (3, 1, 3, 'Fit new seal', 0, 0),
  (4, 1, 4, 'Test run', 0, 0),
  (5, 2, 1, 'Replace filters', 0, 0),
  (6, 2, 2, 'Check refrigerant', 0, 0),
  (7, 2, 3, 'Clean coils', 0, 0),
  (8, 3, 1, 'Inspect belt', 1, 1),
  (9, 3, 2, 'Align pulleys', 1, 2.5),
  (10, 4, 1, 'Run load bank', 0, 0),
  (11, 4, 2, 'Record readings', 0, 0);

INSERT INTO work_order_log (id, work_order_id, logged_at, event, message) VALUES
  (1, 1, '2026-09-01 08:00:00', 'created', 'Work order WO-1001 opened: Replace pump seal'),
  (2, 1, '2026-09-02 07:30:00', 'started', 'Work started on WO-1001'),
  (3, 3, '2026-08-20 09:00:00', 'created', 'Work order WO-1003 opened: Belt alignment'),
  (4, 3, '2026-08-21 08:15:00', 'started', 'Work started on WO-1003'),
  (5, 3, '2026-08-22 16:40:00', 'completed', 'Work completed on WO-1003');
