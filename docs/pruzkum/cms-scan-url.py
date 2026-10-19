import sys, re, ssl, urllib.request, concurrent.futures as cf, collections, json
rows=[l.rstrip('\n').split('\t') for l in open(sys.argv[1],encoding='utf-8') if l.strip()]
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
SIG=[('Galileo (GCM)', r'galileo|\bGCM\b'),('vismo (Webhouse)', r'vismo|webhouse'),('Antee', r'antee'),
     ('e-obec / SPH', r'e-obec|e-obce'),('Obce.cz / Webstranky', r'mesta\.obce\.cz|webstranky\.cz|www\.obce\.cz'),
     ('Proxio', r'proxio'),('Webnode', r'webnode'),('Wix', r'wix\.com|wixstatic'),
     ('WordPress', r'wp-content|wp-includes|content="WordPress'),('Drupal', r'Drupal|/sites/default/files'),
     ('Joomla', r'Joomla|/media/jui/|com_content'),('Kentico', r'Kentico|CMSPages'),('Edookit/Školy', r'edookit')]
def get(u):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0 (pruzkum CMS obecnich webu; platforma@vlastiborice.cz)'}),timeout=12,context=ctx)
    return r.geturl(), r.read(400000).decode('utf-8','replace')
def scan(r):
    name,typ,dom=r
    for u in ([dom.replace('http://','https://',1), dom] if dom.startswith('http') else [f'https://www.{dom}/', f'https://{dom}/', f'http://www.{dom}/']):
        try:
            final,h=get(u); break
        except Exception as e: final,h=None,''
    if not h: return name,typ,dom,None,'nedostupný',''
    found=[n for n,p in SIG if re.search(p,h,re.I)]
    gen=re.search(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']([^"\']+)',h,re.I)
    # priorita: specializovaní dodavatelé před obecnými CMS (Galileo apod. mohou mít v HTML i jiné řetězce)
    cms=found[0] if found else 'jiný / neznámý'
    return name,typ,dom,final,cms,(gen.group(1) if gen else '')
with cf.ThreadPoolExecutor(32) as ex: res=list(ex.map(scan, rows))
json.dump(res, open(sys.argv[2],'w'), ensure_ascii=False)
ok=[r for r in res if r[4]!='nedostupný']
c=collections.Counter(r[4] for r in ok)
print('vzorek', len(res), '| dostupných', len(ok))
for k,n in c.most_common(): print(f'  {k:24} {n:4}  {100*n/len(ok):5.1f} %')
print('generátory u neznámých:', collections.Counter(r[5][:40] for r in ok if r[4]=='jiný / neznámý').most_common(15))
