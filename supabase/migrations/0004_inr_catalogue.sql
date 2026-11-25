begin;

-- Rewrite catalogue price keys for INR quotes.
update printshop.catalogue
set definition = (definition - 'basePence' - 'vatBps') || jsonb_build_object(
    'basePriceMinor', definition->'basePence',
    'taxBps', definition->'vatBps',
    'revision', (definition->>'revision')::int + 1
  ), updated_at = now()
where definition ? 'basePence' and not (definition ? 'basePriceMinor');

commit;
