-- Demo data. All identities are fictional.

insert into registry_patients (philsys_id, family_name, given_name, gender, birth_date) values
  ('1234-5678-9012-3456', 'Dela Cruz', 'Juan',   'male',   '1985-03-14'),
  ('2345-6789-0123-4567', 'Santos',    'Maria',  'female', '1992-11-02'),
  ('3456-7890-1234-5678', 'Reyes',     'Pedro',  'male',   '1958-07-21'),
  ('4567-8901-2345-6789', 'Garcia',    'Ana',    'female', '2019-01-30')
on conflict do nothing;

insert into registry_facilities (nhfr_code, name, fac_type) values
  ('NHFR-0001', 'Barangay Rural Health Unit', 'Rural Health Unit'),
  ('NHFR-0002', 'District Hospital',          'Level 1 Hospital'),
  ('NHFR-0003', 'Provincial Hospital',        'Level 2 Hospital')
on conflict do nothing;

insert into registry_health_workers (nhwr_id, family_name, given_name, role, nhfr_code) values
  ('NHWR-1001', 'Mendoza', 'Liza',   'Physician', 'NHFR-0001'),
  ('NHWR-2001', 'Cruz',    'Roberto','Physician', 'NHFR-0002'),
  ('NHWR-3001', 'Aquino',  'Carmen', 'Physician', 'NHFR-0003')
on conflict do nothing;

insert into emr_clients (emr_id, name, nhfr_code, api_key) values
  ('EMR1', 'EMR 1 - Rural Health Unit',  'NHFR-0001', 'demo-key-emr1'),
  ('EMR2', 'EMR 2 - District Hospital',  'NHFR-0002', 'demo-key-emr2'),
  ('EMR3', 'EMR 3 - Provincial Hospital','NHFR-0003', 'demo-key-emr3')
on conflict do nothing;
