-- S7: project and review lists page before counting. Counts are computed for
-- every visible row only when the caller sorts by a count; otherwise only for
-- the returned page. Order, paging and every count stay exactly as before.
begin;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
$$;
do $$
declare actor uuid:=gen_random_uuid(); review uuid; row_id uuid; i integer;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  perform set_config('mike.test_counts_actor',actor::text,true);
  -- Ties on every key (names, counts, timestamps) exercise the tiebreakers.
  insert into public.projects(user_id,name,cm_number,created_at,updated_at)
    select actor,'Matter '||(n%7),'CM-'||(n%5),now()-(n%9)*interval '1 day',now()-(n%4)*interval '1 hour' from generate_series(1,40) n;
  insert into public.documents(user_id,project_id) select actor,p.id from public.projects p cross join generate_series(1,5) k
    where p.user_id=actor and k<=(abs(hashtext(p.id::text))%6);
  insert into public.chats(user_id,project_id,title) select actor,p.id,'Chat' from public.projects p cross join generate_series(1,3) k
    where p.user_id=actor and k<=(abs(hashtext(p.id::text||'c'))%4);
  insert into public.tabular_reviews(user_id,project_id,title) select actor,p.id,'Review' from public.projects p cross join generate_series(1,2) k
    where p.user_id=actor and k<=(abs(hashtext(p.id::text||'r'))%3);
  -- Standalone reviews: array document_ids (with duplicates) and legacy
  -- non-array reviews counted from their cells.
  for i in 1..30 loop
    insert into public.tabular_reviews(user_id,title,created_at,columns_config,document_ids) values(actor,'Grid '||(i%6),now()-(i%5)*interval '1 day',
      jsonb_build_array(jsonb_build_object('n',i))||case when i%3=0 then '[{}]'::jsonb else '[]'::jsonb end,
      case when i%2=0 then (select jsonb_agg(d.id::text) from (select id from public.documents where user_id=actor order by id limit i%4) d)||'["dup","dup"]'::jsonb end)
      returning id into review;
    if i%2=1 then
      insert into public.tabular_review_rows(review_id,label,row_type) values(review,'Row','document') returning id into row_id;
      insert into public.tabular_cells(review_id,row_id,document_id,column_index)
        select review,row_id,d.id,k from (select id from public.documents where user_id=actor order by id limit i%5) d cross join generate_series(0,1) k;
    end if;
  end loop;
end;
$$;
do $$
declare actor text:=current_setting('mike.test_counts_actor'); key text; dir text; whole jsonb; paged jsonb; expected jsonb; page integer;
begin
  foreach key in array array['name','cm','files','chats','reviews','created','updated'] loop
    foreach dir in array array['asc','desc'] loop
      select jsonb_agg(to_jsonb(o)) into whole from public.get_projects_overview(actor,'','all',2000,0,null,key,dir,null,null) o;
      paged:='[]';
      for page in 0..10 loop
        paged:=paged||coalesce((select jsonb_agg(to_jsonb(o)) from public.get_projects_overview(actor,'','all',4,page*4,null,key,dir,null,null) o),'[]');
      end loop;
      assert paged=whole,format('project pages differ from the full list for %s %s',key,dir);
      execute format($q$select jsonb_agg(jsonb_build_array(id,document_count,chat_count,review_count) order by %s %s, created_at desc, id) from (
          select p.*,(select count(*) from public.documents d where d.project_id=p.id)::integer document_count,
            (select count(*) from public.chats c where c.project_id=p.id)::integer chat_count,
            (select count(*) from public.tabular_reviews r where r.project_id=p.id)::integer review_count
          from public.projects p where p.user_id=$1::uuid) x$q$,
        case key when 'name' then 'lower(coalesce(name,''''))' when 'cm' then 'lower(coalesce(cm_number,''''))' when 'files' then 'document_count'
          when 'chats' then 'chat_count' when 'reviews' then 'review_count' when 'created' then 'created_at' else 'updated_at' end,dir)
        into expected using actor;
      assert (select jsonb_agg(jsonb_build_array(e->'id',e->'document_count',e->'chat_count',e->'review_count')) from jsonb_array_elements(whole) e)=expected,
        format('project order or counts changed for %s %s',key,dir);
    end loop;
  end loop;
  foreach key in array array['name','columns','documents','updated','created'] loop
    foreach dir in array array['asc','desc'] loop
      select jsonb_agg(to_jsonb(o)) into whole from public.get_tabular_reviews_overview(actor,'',null,'standalone',2000,0,null,key,dir) o;
      paged:='[]';
      for page in 0..10 loop
        paged:=paged||coalesce((select jsonb_agg(to_jsonb(o)) from public.get_tabular_reviews_overview(actor,'',null,'standalone',4,page*4,null,key,dir) o),'[]');
      end loop;
      assert paged=whole,format('review pages differ from the full list for %s %s',key,dir);
      execute format($q$select jsonb_agg(jsonb_build_array(id,document_count) order by %s %s, created_at desc, id) from (
          select r.*,case when jsonb_typeof(r.document_ids)='array' then (select count(distinct v)::integer from jsonb_array_elements_text(r.document_ids) v)
            else (select count(distinct c.document_id)::integer from public.tabular_cells c where c.review_id=r.id) end document_count
          from public.tabular_reviews r where r.user_id=$1::uuid and r.project_id is null) x$q$,
        case key when 'name' then 'lower(coalesce(title,''''))' when 'columns' then 'jsonb_array_length(coalesce(columns_config,''[]''))'
          when 'documents' then 'document_count' when 'updated' then 'coalesce(updated_at,created_at)' else 'created_at' end,dir)
        into expected using actor;
      assert (select jsonb_agg(jsonb_build_array(e->'id',e->'document_count')) from jsonb_array_elements(whole) e)=expected,
        format('review order or counts changed for %s %s',key,dir);
    end loop;
  end loop;
end;
$$;
-- A page of one, sorted by date, counts one project's or review's rows.
-- The fixture is small enough for a sequential scan to look cheapest, which
-- would hide the difference between counting one row and counting all.
set local enable_seqscan=off;
do $$
declare actor text:=current_setting('mike.test_counts_actor'); before bigint; reads bigint;
begin
  before:=pg_temp.rel_work('public.documents');
  perform * from public.get_projects_overview(actor,'','all',1,0,null,'created','desc',null,null);
  reads:=pg_temp.rel_work('public.documents')-before;
  assert reads<=10,format('a one-project page counted %s document rows',reads);
  before:=pg_temp.rel_work('public.tabular_cells');
  perform * from public.get_tabular_reviews_overview(actor,'',null,'standalone',1,0,null,'created','desc');
  reads:=pg_temp.rel_work('public.tabular_cells')-before;
  assert reads<=10,format('a one-review page counted %s cell rows',reads);
end;
$$;
rollback;
