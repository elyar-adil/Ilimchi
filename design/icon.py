# 生成应用图标：白底上 3D 倾斜的论文片段，一个词被黄色高亮。
# 用法：python3 design/icon.py design/icon.svg，再用浏览器渲染成 180px / 64px PNG 写入 index.html。
import math, random, sys
S=1024
# page in its own plane coords (units px), origin at page center
PW,PH=760,1000
rx=math.radians(-42); rz=math.radians(-18); ry=math.radians(0)
D=1500  # camera distance
CX,CY=S*0.55,S*0.47
def proj(x,y):
    # rotate around z (in-plane), then x tilt, then y
    x1=x*math.cos(rz)-y*math.sin(rz); y1=x*math.sin(rz)+y*math.cos(rz); z1=0
    y2=y1*math.cos(rx)-z1*math.sin(rx); z2=y1*math.sin(rx)+z1*math.cos(rx); x2=x1
    x3=x2*math.cos(ry)+z2*math.sin(ry); z3=-x2*math.sin(ry)+z2*math.cos(ry); y3=y2
    k=D/(D+z3)
    return CX+x3*k, CY+y3*k
def rrect(x,y,w,h,r,n=6):
    r=min(r,w/2,h/2); pts=[]
    for cx,cy,a0 in [(x+w-r,y+r,-90),(x+w-r,y+h-r,0),(x+r,y+h-r,90),(x+r,y+r,180)]:
        for i in range(n+1):
            a=math.radians(a0+90*i/n); pts.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    # densify straight edges for perspective (fine; projection of lines stays lines)
    return pts
def poly(pts,**attrs):
    p=' '.join(f'{a:.1f},{b:.1f}' for a,b in (proj(x,y) for x,y in pts))
    at=' '.join(f'{k.replace("_","-")}="{v}"' for k,v in attrs.items())
    return f'<polygon points="{p}" {at}/>'
random.seed(int(sys.argv[2]) if len(sys.argv)>2 else 7)
out=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">',
'<defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>',
'<linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f2f4"/></linearGradient>',
'<linearGradient id="hl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd84d"/><stop offset="1" stop-color="#ffc828"/></linearGradient></defs>',
f'<rect width="{S}" height="{S}" fill="#ffffff"/>']
x0,y0=-PW/2,-PH/2
# shadow: page outline offset
sh=[(x+18,y+34) for x,y in rrect(x0,y0,PW,PH,26)]
out.append(f'<g filter="url(#sh)" opacity="0.34">'+poly(sh,fill="#1d2b3a")+'</g>')
# sheet behind (stack)
out.append(poly(rrect(x0+22,y0+22,PW,PH,26),fill="#dfe3e8"))
out.append(poly(rrect(x0,y0,PW,PH,26),fill="url(#pg)",stroke="#dfe2e6",stroke_width="2"))
# text lines
mx=84; lh=92; th=34
y=y0+92
# title line (bolder)
out.append(poly(rrect(x0+mx,y,330,52,26),fill="#1f2a37"))
y+=120
LINES=[[0.30,0.42,0.28],[0.22,0.33,0.45],[0.48,0.20,0.32],[0.26,0.36,0.38],[0.40,0.60],[0.34,0.30,0.36],[0.24,0.44,0.32],[0.38,0.27,0.35]]
LAST={4}
HL=(3,1)
gap=34
for li,fr in enumerate(LINES):
    if y+th>y0+PH-40: break
    left=x0+mx; full=PW-2*mx
    width = full*0.62 if li in LAST else full
    avail=width-gap*(len(fr)-1)
    x=left
    for wi,f in enumerate(fr):
        ww=avail*f
        if (li,wi)==HL:
            out.append(poly(rrect(x-20,y-20,ww+40,th+40,14),fill="url(#hl)"))
            out.append(poly(rrect(x,y,ww,th,th/2),fill="#3a2e06"))
        else:
            out.append(poly(rrect(x,y,ww,th,th/2),fill="#b4bcc6"))
        x+=ww+gap
    y+=lh
out.append('</svg>')
open(sys.argv[1],'w').write('\n'.join(out))
