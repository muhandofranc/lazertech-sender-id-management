-- Bootstrap super admin, so a fresh install has a way in without running
-- the seed script first.
--
--     username: admin
--     password: ChangeMe@123
--
-- CHANGE THIS PASSWORD IMMEDIATELY AFTER THE FIRST LOGIN. It is published in
-- this repository, so anyone who can read the source knows it. Change it from
-- the Users tab, or with:
--
--     npm run seed-user -- admin '<new password>' super_admin
--
-- The hash below is bcrypt (cost 12) of the password above; SQL cannot compute
-- bcrypt, so it has to be precomputed and pasted in.
--
-- This only fires on a genuinely fresh install: the INSERT is guarded on the
-- table being empty, so re-running the migration never resurrects a deleted
-- admin, never resets a password that has since been changed, and never
-- re-adds the account on an instance that has moved on to real users.

--- Default: admin / ChangeMe@123 ---
INSERT INTO `dashboard_users` (`username`, `password_hash`, `role`, `is_active`)
SELECT 'admin',
       '$2a$12$qDJKtoFtrv1rN9gb/JPeWOQrBeOO26kKJJXPRSA74u2Xz1Mhfql3.',
       'super_admin',
       1
 WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM `dashboard_users` LIMIT 1) AS existing);
