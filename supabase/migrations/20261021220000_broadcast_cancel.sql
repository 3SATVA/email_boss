-- Canceling a broadcast (update ... set status = 'canceled') also cancels its not-yet-sent emails.
create or replace function email_boss.cancel_broadcast_sends() returns trigger
language plpgsql as $$
begin
  if new.status = 'canceled' and old.status is distinct from 'canceled' then
    update email_boss.sends set status = 'canceled', error = 'broadcast canceled'
     where broadcast_id = new.id and status = 'queued';
  end if;
  return new;
end $$;

create trigger broadcasts_cancel_sends after update of status on email_boss.broadcasts
  for each row execute function email_boss.cancel_broadcast_sends();
