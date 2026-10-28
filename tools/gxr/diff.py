import os, sys, struct, numpy as np
from PIL import Image
def load(p):
    d=open(p,'rb').read(); w,h,_=struct.unpack('<III',d[:12]); return np.frombuffer(d[12:12+w*h*4],dtype=np.uint8).reshape(h,w,4)
name, k = sys.argv[1], int(sys.argv[2])
cand = sys.argv[3] if len(sys.argv)>3 else 'out/cpu'
a=load(f'{cand}/{name}/efb_{k:06d}.raw'); b=load(f'{os.environ.get("GX_SPEC_HARNESS","spec/harness")}/reference/{name}/efb_{k:06d}.raw')
d=np.abs(a[...,:3].astype(int)-b[...,:3].astype(int)).max(axis=2)
ys,xs=np.where(d!=0)
print('diff', len(ys), 'bbox', xs.min() if len(xs) else None, ys.min() if len(xs) else None, xs.max() if len(xs) else None, ys.max() if len(xs) else None)
# cluster by 32x32 cells
from collections import Counter
c=Counter(zip((xs//32).tolist(),(ys//32).tolist()))
print(sorted(c.items(), key=lambda t:-t[1])[:15])
if len(sys.argv)>4:
    x0,y0,x1,y1=map(int,sys.argv[4].split(','))
    sc=int(sys.argv[5]) if len(sys.argv)>5 else 4
    ca=a[y0:y1,x0:x1,:3]; cb=b[y0:y1,x0:x1,:3]; cd=np.clip(np.abs(ca.astype(int)-cb.astype(int))*10,0,255).astype(np.uint8)
    im=np.concatenate([ca,cb,cd],axis=1)
    Image.fromarray(im).resize((im.shape[1]*sc,im.shape[0]*sc),Image.NEAREST).save('out/crop.png')
