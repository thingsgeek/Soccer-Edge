import json, time, urllib.request, urllib.parse, sys, os
B='https://api.elections.kalshi.com/trade-api/v2'
def get(path, **q):
    url=B+path+('?'+urllib.parse.urlencode(q) if q else '')
    for i in range(6):
        try:
            with urllib.request.urlopen(url, timeout=30) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code==429: time.sleep(2*(i+1)); continue
            raise
        except Exception: time.sleep(2)
    raise RuntimeError(url)
series=[s for s in get('/series', category='Sports').get('series',[]) if 'Soccer' in (s.get('tags') or [])]
json.dump(series, open('series.json','w'))
print('soccer series', len(series), flush=True)
# Team names come from events of every series (game/total/btts/teamtotal...). Pull events of all statuses.
out={}
for n,s in enumerate(series):
    t=s['ticker']; evs=[]; cursor=None
    for page in range(3):
        q=dict(series_ticker=t, limit=200)
        if cursor: q['cursor']=cursor
        r=get('/events', **q); time.sleep(0.06)
        evs+= [{'t':e['event_ticker'],'title':e.get('title',''),'sub':e.get('sub_title','')} for e in r.get('events',[])]
        cursor=r.get('cursor')
        if not cursor: break
    out[t]=evs
    if n%100==0: print(n, t, len(evs), flush=True); json.dump(out, open('events.json','w'))
json.dump(out, open('events.json','w'))
print('done', sum(len(v) for v in out.values()), 'events')
