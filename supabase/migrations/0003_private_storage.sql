begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('press-private', 'press-private', false, 52428800)
on conflict (id) do nothing;

-- Keep staging and output objects private. Server routes issue
-- signed grants after checking the account, order, and file state.

commit;
