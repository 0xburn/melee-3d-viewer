import json,sys,collections
p=json.load(open(sys.argv[1]))
nodes={n['id']:n for n in p['nodes']}
self_t=collections.Counter()
dt=p['timeDeltas']; samples=p['samples']
for i,s in enumerate(samples): self_t[s]+=dt[i] if i<len(dt) else 0
tot=sum(self_t.values())
by=collections.Counter()
for nid,t in self_t.items():
    cf=nodes[nid]['callFrame']; by[(cf['functionName'] or '(anon)', cf['url'].split('/')[-1], cf['lineNumber'])]+=t
print('total ms',tot/1000)
for (f,u,l),t in by.most_common(int(sys.argv[2]) if len(sys.argv)>2 else 25): print('%7.1f ms %5.1f%%  %s %s:%d'%(t/1000,100*t/tot,f,u,l))
