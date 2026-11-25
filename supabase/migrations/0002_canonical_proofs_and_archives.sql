begin;

alter table printshop.proofs add column hash_format text not null default 'json-v0'
  check (hash_format in ('json-v0', 'canonical-v1'));
alter table printshop.proofs alter column hash_format set default 'canonical-v1';

alter table printshop.manifest
  drop constraint manifest_row_number_check,
  drop constraint manifest_check,
  add constraint manifest_row_number_check check (row_number between 0 and 2000),
  add constraint manifest_entry_type_check check (format = 'zip' or row_number between 1 and 1000);

commit;
