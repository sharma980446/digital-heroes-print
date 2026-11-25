begin;

create schema printshop;
revoke all on schema printshop from public;

create table printshop.accounts (
  id uuid primary key,
  email text not null unique,
  display_name text not null,
  role text not null default 'customer' check (role in ('customer', 'staff')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table printshop.demo_credentials (
  account_id uuid primary key references printshop.accounts(id) on delete cascade,
  secret text not null
);

create table printshop.demo_sessions (
  token_hash text primary key,
  account_id uuid not null references printshop.accounts(id) on delete cascade,
  expires_at timestamptz not null
);

create table printshop.catalogue (
  id text primary key,
  definition jsonb not null,
  updated_at timestamptz not null default now()
);

create table printshop.orders (
  id uuid primary key,
  number bigint generated always as identity (start with 1001) unique,
  owner_id uuid not null references printshop.accounts(id),
  product_id text not null references printshop.catalogue(id),
  idempotency_key uuid not null,
  config jsonb not null,
  product_snapshot jsonb not null,
  price jsonb not null,
  draft jsonb not null,
  draft_csv text not null default '',
  draft_mapping jsonb not null default '{"name":"name","number":"number"}',
  stage text not null default 'order' check (stage in ('order', 'artwork', 'proof', 'production', 'completed')),
  proof_state text not null default 'draft' check (proof_state in ('draft', 'review', 'changes', 'approved')),
  current_proof_id uuid,
  paid_proof_id uuid,
  paid_at timestamptz,
  payment_review boolean not null default false,
  reordered_from uuid references printshop.orders(id),
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (owner_id, idempotency_key),
  check ((paid_proof_id is null) = (paid_at is null)),
  check ((stage = 'completed') = (completed_at is not null))
);
create index orders_owner_date_idx on printshop.orders(owner_id, created_at desc);
create index orders_queue_idx on printshop.orders(stage, product_id, created_at desc);

create table printshop.assets (
  id uuid primary key,
  order_id uuid not null references printshop.orders(id),
  kind text not null check (kind in ('logo', 'artwork')),
  format text not null check (format in ('pdf', 'png', 'svg', 'ai')),
  state text not null default 'pending' check (state in ('pending', 'ready')),
  staging_key text not null unique,
  object_key text unique,
  sha256 text,
  pixel_width int,
  pixel_height int,
  created_at timestamptz not null default now()
);

create table printshop.proofs (
  id uuid primary key,
  order_id uuid not null references printshop.orders(id),
  version int not null check (version > 0),
  snapshot jsonb not null,
  sha256 text not null,
  published_by uuid not null references printshop.accounts(id),
  created_at timestamptz not null default now(),
  unique (order_id, version),
  unique (order_id, id)
);
alter table printshop.orders
  add foreign key (id, current_proof_id) references printshop.proofs(order_id, id),
  add foreign key (id, paid_proof_id) references printshop.proofs(order_id, id);

create table printshop.approvals (
  proof_id uuid primary key references printshop.proofs(id),
  actor_id uuid not null references printshop.accounts(id),
  carried_from uuid references printshop.proofs(id),
  approved_at timestamptz not null default now()
);

create table printshop.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references printshop.orders(id),
  actor_id uuid references printshop.accounts(id),
  proof_id uuid references printshop.proofs(id),
  event_type text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index order_events_order_idx on printshop.order_events(order_id, id desc);

create table printshop.checkout_attempts (
  id uuid primary key,
  order_id uuid not null,
  proof_id uuid not null,
  provider text not null check (provider in ('stripe', 'demo')),
  provider_session text unique,
  expected_amount int not null check (expected_amount > 0),
  currency char(3) not null,
  status text not null default 'open' check (status in ('open', 'closed', 'settled')),
  created_at timestamptz not null default now(),
  foreign key (order_id, proof_id) references printshop.proofs(order_id, id)
);
create unique index checkout_open_idx on printshop.checkout_attempts(order_id, proof_id) where status = 'open';

create table printshop.payment_event_log (
  provider text not null,
  event_id text not null,
  attempt_id uuid not null references printshop.checkout_attempts(id),
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table printshop.payments (
  id uuid primary key,
  attempt_id uuid not null references printshop.checkout_attempts(id),
  order_id uuid not null,
  proof_id uuid not null,
  provider text not null,
  reference text not null,
  amount int not null check (amount >= 0),
  currency char(3) not null,
  status text not null check (status in ('applied', 'review')),
  review_reason text,
  paid_at timestamptz not null,
  foreign key (order_id, proof_id) references printshop.proofs(order_id, id),
  unique (provider, reference)
);
create unique index payments_applied_idx on printshop.payments(order_id) where status = 'applied';
create index payments_reporting_idx on printshop.payments(paid_at, status);

create table printshop.jobs (
  id uuid primary key,
  order_id uuid not null,
  proof_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  expected_rows int not null check (expected_rows between 1 and 1000),
  processed_rows int not null default 0 check (processed_rows between 0 and expected_rows),
  attempts int not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (order_id, proof_id) references printshop.proofs(order_id, id),
  unique (order_id, proof_id),
  unique (id, order_id, proof_id)
);
create index jobs_claim_idx on printshop.jobs(status, created_at);

create table printshop.manifest (
  job_id uuid not null,
  order_id uuid not null,
  proof_id uuid not null,
  row_number int not null check (row_number between 0 and 1000),
  format text not null check (format in ('pdf', 'png', 'zip')),
  object_key text not null unique,
  filename text not null,
  sha256 text not null,
  size_bytes int not null check (size_bytes > 0),
  foreign key (job_id, order_id, proof_id) references printshop.jobs(id, order_id, proof_id),
  check ((row_number = 0) = (format = 'zip')),
  primary key (job_id, row_number, format)
);

create table printshop.notifications (
  id uuid primary key,
  event_id bigint not null references printshop.order_events(id),
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'demo')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  unique (event_id, recipient)
);

-- The application schema is private and served through the Node API. Enable RLS
-- with no public policies in case a project later exposes the schema.
do $block$
declare table_name text;
begin
  for table_name in select tablename from pg_tables where schemaname = 'printshop'
  loop
    execute format('alter table printshop.%I enable row level security', table_name);
  end loop;
end
$block$;

commit;
