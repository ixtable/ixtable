-- CRM sample records. Applied once, after the schema, as the "Seed sample data" migration.
INSERT INTO deal_stages (id, name, position, probability, is_closed) VALUES
  (1, 'Lead', 1, 0.1, 0),
  (2, 'Qualified', 2, 0.25, 0),
  (3, 'Proposal', 3, 0.5, 0),
  (4, 'Negotiation', 4, 0.75, 0),
  (5, 'Won', 5, 1, 1),
  (6, 'Lost', 6, 0, 1);

INSERT INTO companies (id, name, industry, website, city, created_on) VALUES
  (1, 'Acme Corp', 'Manufacturing', 'https://acme.example', 'Boston', '2026-01-12'),
  (2, 'Globex', 'Energy', 'https://globex.example', 'Springfield', '2026-02-03'),
  (3, 'Initech', 'Software', 'https://initech.example', 'Austin', '2026-02-20'),
  (4, 'Umbrella Health', 'Healthcare', 'https://umbrella.example', 'Denver', '2026-03-08'),
  (5, 'Stark Logistics', 'Logistics', 'https://stark.example', 'Seattle', '2026-04-15');

INSERT INTO contacts (id, company_id, name, email, phone, title) VALUES
  (1, 1, 'Ada Lovelace', 'ada@acme.example', '555-0101', 'CTO'),
  (2, 1, 'Bob Builder', 'bob@acme.example', '555-0102', 'Plant manager'),
  (3, 2, 'Carla Gomez', 'carla@globex.example', '555-0201', 'Head of operations'),
  (4, 3, 'Dan Brown', 'dan@initech.example', '555-0301', 'IT director'),
  (5, 3, 'Eve Adams', 'eve@initech.example', '555-0302', 'Procurement'),
  (6, 4, 'Frank Ocean', 'frank@umbrella.example', '555-0401', 'CIO'),
  (7, 5, 'Grace Hopper', 'grace@stark.example', '555-0501', 'VP engineering'),
  (8, 5, 'Hank Pym', 'hank@stark.example', '555-0502', 'Fleet manager');

INSERT INTO deals (id, company_id, contact_id, stage_id, title, amount, status, close_date, owner) VALUES
  (1, 1, 1, 3, 'Factory sensors', 12000, 'open', '2026-11-30', 'Sam'),
  (2, 1, 2, 4, 'Maintenance contract', 8000, 'open', '2026-10-31', 'Sam'),
  (3, 2, 3, 2, 'Grid analytics', 25000, 'open', '2026-12-15', 'Alex'),
  (4, 2, 3, 5, 'Analytics pilot', 5000, 'won', '2026-06-30', 'Alex'),
  (5, 3, 4, 1, 'Seat licenses', 3000, 'open', NULL, 'Sam'),
  (6, 3, 5, 3, 'Support renewal', 7000, 'open', '2026-11-01', 'Jo'),
  (7, 4, 6, 4, 'Patient portal', 40000, 'open', '2026-12-31', 'Jo'),
  (8, 4, 6, 6, 'Staff training', 2000, 'lost', '2026-05-20', 'Jo'),
  (9, 5, 7, 2, 'Fleet tracking', 15000, 'open', '2027-01-31', 'Alex'),
  (10, 5, 8, 1, 'Route optimisation', 9000, 'open', NULL, 'Alex');

INSERT INTO activities (id, company_id, deal_id, contact_id, kind, subject, due_date, done, notes) VALUES
  (1, 1, 1, 1, 'call', 'Intro call', '2026-09-01', 1, NULL),
  (2, 1, 1, 2, 'meeting', 'Site visit', '2026-09-10', 1, 'Walked the assembly line.'),
  (3, 1, 1, 1, 'email', 'Send proposal', '2026-10-05', 0, NULL),
  (4, 2, 3, 3, 'call', 'Discovery call', '2026-10-08', 0, NULL),
  (5, 2, 4, 3, 'meeting', 'Pilot review', '2026-06-25', 1, NULL),
  (6, 3, 5, 4, 'email', 'Licence quote', '2026-10-12', 0, NULL),
  (7, 3, 6, 5, 'call', 'Renewal check-in', '2026-09-20', 1, NULL),
  (8, 4, 7, 6, 'meeting', 'Security review', '2026-10-15', 0, NULL),
  (9, 4, 7, 6, 'call', 'Budget call', '2026-09-18', 1, NULL),
  (10, 4, 8, 6, 'note', 'Lost to incumbent', '2026-05-20', 1, NULL),
  (11, 5, 9, 7, 'call', 'Fleet demo', '2026-10-20', 0, NULL),
  (12, 5, 10, 8, 'email', 'Send case study', '2026-10-22', 0, NULL);
