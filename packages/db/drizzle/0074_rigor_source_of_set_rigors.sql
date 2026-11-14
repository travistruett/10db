-- Authored once, never regenerated. A rigor stored before sizing kept no source. It was set by the builder
-- (the form, the playbook move) or by an agent that no row records, and an unknown source must pin, so every
-- stored rigor reads as the builder's.
UPDATE `tasks` SET `rigor_source` = 'builder' WHERE `rigor` IS NOT NULL AND `rigor_source` IS NULL;
