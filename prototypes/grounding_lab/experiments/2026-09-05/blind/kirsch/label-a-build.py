import json
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).parent
claims = json.loads((ROOT / 'claims.json').read_text(encoding='utf-8-sig'))
anchors = json.loads((ROOT / 'anchors.json').read_text(encoding='utf-8-sig'))
rules = {}

def rule(rec, field, value, indices, note='', supported=True, status='resolved'):
    key = (rec, field, json.dumps(value, ensure_ascii=False))
    assert key not in rules, key
    sets = [[i] for i in indices] if indices and isinstance(indices[0], int) else indices
    rules[key] = (supported, sets, note, status)

def fields(rec, spec):
    for field, value, evidence in spec:
        rule(rec, field, value, evidence)

def identity(rec, site, heading):
    fields(rec, [('catalogue_id', rec, [heading]), ('site', site, [heading])])

identity('311', 'Parstein', 63)
fields('311', [('burial_type','Steinkistengrab',[64,68]),('findspot_id','2',[66]),('discovery_year',1932,[67]),('orientation','O-W',[69]),('construction_type','Steinkiste',[64,68]),('construction_type','versenkte Steinkiste',[68]),('chamber_length_value',1.3,[69]),('chamber_length_unit','m',[69]),('chamber_width_unit','m',[69])])
rule('311','chamber_width_value',0.8,[], 'Width is the range 0.8–0.9 m, not exactly its lower endpoint.',False)

identity('316','Stolzenhagen',116)
fields('316',[('burial_type','Grabhügel mit Steinkistengrab',[117]),('findspot_id','5',[118]),('discovery_year',1910,[119]),('orientation','N-S',[120]),('body_position','rechter Hocker',[122]),('individual_count',2,[122]),('construction_type','Steinkiste',[117,120]),('construction_type','Steinkiste in Lehm eingesenkt',[120]),('chamber_length_value',1.3,[122]),('chamber_length_unit','m',[122]),('chamber_width_value',0.6,[122]),('chamber_width_unit','m',[122])])
rule('316','sex','eher männlich; eher weiblich',[], 'PDF page 2 (printed p.84) describes individuals a and b separately. The frozen instruction forbids combining their distinct sex assessments into a shared record field.',False)
rule('316','age_class','über 50 Jahre; 40–50 Jahre',[], 'PDF page 2 (printed p.84) assigns these different ages to individuals a and b. This combined field conflates individuals contrary to the frozen instruction.',False)

identity('331','Hohensaaten',271)
fields('331',[('burial_type','Grab',[272]),('discovery_year',1879,[274]),('orientation','N-S',[276]),('construction_type','Steinpackung',[276]),('individual_count',1,[276]),('pit_depth_unit','m',[276])])
rule('331','pit_depth_value',1,[],'Depth is expressly etwa 1 m; the exact numeric claim drops the approximation.',False)

identity('356','Neuendorf (im Sande)',519)
fields('356',[('burial_type','Grab',[520,578]),('discovery_year',1930,[522]),('pit_depth_unit','m',[523]),('construction_type','Grabgrube mit großen Geschieben',[523])])
rule('356','pit_depth_value',1.2,[],'Source gives T etwa 1.2 m, so the uncertain numeric measurement must be null.',False)

identity('363','Tempelberg',602)
fields('363',[('burial_type','Steinkistengrab',[603,608]),('findspot_id','1',[604]),('discovery_year',1872,[605,608]),('orientation','O-W',[608]),('construction_type','Steinkiste',[603,608]),('construction_type','eingetiefte Steinkiste',[608]),('chamber_length_value',4.8,[608]),('chamber_length_unit','m',[608]),('chamber_width_unit','m',[608])])
rule('363','chamber_width_value',1.1,[],'The west width is 1.1–1.2 m, and the east width approximately 1.5 m; exact 1.1 is unsupported.',False)

fields('364.4',[('catalogue_id','364.4',[715]),('site','Trebus',[654]),('grave_id','C',[716,655]),('burial_type','Flachgrab',[716]),('findspot_id','1',[656]),('discovery_year',1926,[657,659]),('pit_depth_value',2.05,[718]),('pit_depth_unit','m',[718]),('construction_type','Grube',[717,718])])

schwedt = {
 '369.1': (766,768,769), '369.2': (776,777,779),
 '369.3': (785,786,788), '369.4': (797,798,799),
 '369.5': (804,806,805), '369.6': (810,813,811),
 '369.7': (817,819,819),
}
for rec, (heading, grave, desc) in schwedt.items():
    fields(rec,[('catalogue_id',rec,[heading]),('site','Schwedt',[761]),('grave_id','Grab '+rec[-1],[grave]),('findspot_id','5',[763]),('discovery_year',1902,[764]),('burial_type','Körpergrab',[desc]),('individual_count',1,[desc])])
    rule(rec,'burial_type','Gräberfeld',[],'Gräberfeld describes parent catalogue 369. The intended separately numbered record is a single skeletal grave, not the cemetery as its burial type.',False)
fields('369.1',[('construction_type','Steinplatte',[769])])

identity('371','Falkenhagen',842)
fields('371',[('burial_type','Grab',[843]),('burial_type','Steingrab',[847]),('construction_type','Steingrab',[847]),('discovery_year',1867,[845])])

fields('375.1',[('catalogue_id','375.1',[877]),('site','Jahnsfelde',[875]),('findspot_id','3',[876]),('discovery_year',1936,[878]),('burial_type','Flachgrab',[879]),('body_position','rechter Hocker',[879]),('pit_depth_value',0.4,[879]),('pit_depth_unit','m',[879]),('individual_count',1,[879])])
rule('375.1','grave_id','1',[],'PDF p.100 uses catalogue subdivision 375.1; it does not assign this feature an independent Grab 1 identifier. The catalogue suffix cannot be copied into grave_id.',False)

identity('383','Buckow',992)
fields('383',[('burial_type','Grab',[993]),('findspot_id','12',[994]),('body_position','Hockerbestattung',[996]),('individual_count',1,[996])])
rule('383','burial_type','Flachgrab',[],'The source says offenbar Flachgrab; the emitted subtype omits its qualification.',False)
rule('383','discovery_year',1955,[],'Mitte der 1950er Jahre is a period, not an explicitly stated year 1955.',False)

identity('397','Bagemühl',1170)
fields('397',[('burial_type','Steinkistengrab',[1171,1173]),('findspot_id','19',[1172]),('discovery_year',1976,[1173]),('construction_type','Steinkiste',[1171,1173]),('construction_type','versenkte Steinkiste',[1173])])
rule('397','orientation','O-W',[],'Source orientation is O-W ?; the uncertain string must retain its question mark.',False)
rule('397','individual_count',3,[],'Source says mindestens 3 Individuen; this lower bound does not support exact count 3.',False)

fields('398.1',[('catalogue_id','398.1',[1188]),('site','Bagemühl',[1184]),('grave_id','Grab I',[1190]),('grave_id','I',[1190]),('burial_type','Steinkistengrab',[1185,1190]),('findspot_id','20 (a)',[1186]),('discovery_year',1933,[1187]),('orientation','NO-SW',[1190]),('construction_type','Steinkiste',[1190]),('construction_type','versenkte Steinkiste',[1190]),('chamber_length_value',1.15,[1190]),('chamber_length_unit','m',[1190]),('chamber_width_unit','m',[1190])])
rule('398.1','chamber_width_value',0.6,[],'Interior width is 0.6–0.8 m; an exact lower endpoint is unsupported.',False)

identity('402','Bagemühl',1239)
fields('402',[('burial_type','Steinkistengrab',[1240,1244]),('grave_id','Grab II',[1244]),('grave_id','II',[1244]),('orientation','N-S',[1244]),('construction_type','Steinkiste',[1240,1244]),('construction_type','eingesenkte Steinkiste',[1244]),('chamber_length_value',0.75,[1244]),('chamber_length_unit','m',[1244]),('chamber_width_unit','m',[1244])])
rule('402','discovery_year',1937,[],'The source gives 1937 ?; the date is uncertain, not an exact supported year.',False)
rule('402','chamber_width_value',0.4,[],'The source gives chamber dimensions 0.75 × 0.4–0.5 m; width 0.4 alone is unsupported.',False)

identity('403','Bagemühl',1248)
fields('403',[('burial_type','Steinkistengrab',[1249,1253]),('grave_id','Grab III',[1253]),('grave_id','III',[1253]),('construction_type','Steinkiste',[1249,1253])])

def item(rec, index, types, anchor, itemid=None, count=1, height=None, material=None, alternatives=None):
    prefix = f'grave_goods.{index}.'
    for typename in types:
        rule(rec, prefix+'item_type', typename, [anchor])
    if itemid is not None:
        rule(rec, prefix+'item_id', itemid, [anchor], 'Original item label verified against the PDF; numbering is read with the canonical passage in its local list context.')
    if count is not None:
        rule(rec, prefix+'item_count', count, [anchor]+(alternatives or []), 'One described object (or explicitly stated quantity); not a count inferred from an illustration.')
    if height is not None:
        rule(rec,prefix+'height_value',height,[anchor])
        rule(rec,prefix+'height_unit','cm',[anchor], 'The local object measurement series explicitly ends in cm.')
    if material is not None:
        rule(rec,prefix+'material',material,[anchor])

# Hohensaaten changes array position across claims; resolve by item description.
# These rules are selected separately below, because array index alone is not identity.
item('356',0,['KA','Kugelamphore'],524,'a',height=21.6)
item('356',1,['KA','Kugelamphore'],526,'b',height=26)
rules[('356','grave_goods.1.height_value','26')] = (False, [], 'The source explicitly says rekonstr. H 26; an unqualified exact height removes the reconstruction qualifier.', 'resolved')

item('363',0,['Schleifplatte'],609,count=1,material='Sandstein',alternatives=[608])
rule('363','grave_goods.1.item_type','Knochen',[], 'Source human skeletal remains are the deceased, not grave goods. The pig find is specifically a molar; recent rodent remains are intrusive. None supports undifferentiated Knochen as an established grave-good item.',False)

item('364.4',0,['KA','Kugelamphore'],719,'1',height=16.5)
# The description crosses a PDF-page boundary. The height/unit are entirely in the continuation.
for field in ('height_value','height_unit'):
    value = 16.5 if field=='height_value' else 'cm'
    rules[('364.4','grave_goods.0.'+field,json.dumps(value))] = (True,[[720]],'The continuation of vessel 1 explicitly gives H 16.5 and cm.', 'resolved')
item('364.4',1,['KA','Kugelamphore'],721,'2',height=23)
item('364.4',2,['Gefäß'],722,'3',height=22.5)
item('364.4',3,['Topf'],723,'4',height=22.5)
item('364.4',4,['KA','Kugelamphore'],724,'5',height=18.5)
item('364.4',5,['Vorratsgefäß'],725,'6',height=42.5)
for key in list(rules):
    if key[0]=='364.4' and key[1].startswith('grave_goods.5.'):
        support, sets, note, status = rules[key]
        rules[key] = (None, [], 'PDF pp.95–96 describes vessel 6 in younger Grube B, 0.4 m above vessels 1–5. Its identity and dimensions are stated, but whether it is a later grave offering or unrelated younger material is explicitly unresolved (canonical passages 718, 725, 729). This cannot settle its placement as a grave good of C.', 'unresolved')

item('369.1',0,['Hängegefäß'],770,'1',height=10,alternatives=[769])
item('369.1',1,['Schleifstein'],771,'2',alternatives=[769])
item('369.1',2,['Steinaxt'],772,'3',alternatives=[769])
for index, typename, badid, actual in [(1,'Schleifstein','2','3'),(2,'Steinaxt','3','2')]:
    for field, value in [('item_id',badid),('item_type',typename)]:
        rules[('369.1',f'grave_goods.{index}.{field}',json.dumps(value,ensure_ascii=False))] = (False,[],f'Original PDF p.97 numbers {typename} as item {actual}, not {badid}. The claim pairs a source item identifier with the other object; OCR reading order must not renumber them.','resolved')
    source_anchor = 772 if badid=='2' else 771
    rules[('369.1',f'grave_goods.{index}.item_count','1')] = (True,[[source_anchor],[769]],'The source reports one axe (item 2) and one grinding stone (item 3); the quantity remains one even though the emitted item type/identifier pairing is swapped.','resolved')

item('369.2',0,['Zweihenkelkrug'],778,'1',height=16.4)
for field,value in [('height_value',16.4),('height_unit','cm')]:
    rules[('369.2','grave_goods.0.'+field,json.dumps(value))] = (True,[[780]],'The continuation for vessel 1 explicitly gives H 16.4 and cm; only Mdm is qualified as reconstructed.','resolved')
item('369.2',1,['Zweihenkelkrug'],782,'2',height=14)
item('369.3',0,['Zweihenkelkrug'],787,'1',height=15)
item('369.3',1,['Schnurbecher'],789,'2',height=8.8)
rules[('369.3','grave_goods.1.height_value','8.8')] = (False,[],'PDF p.97 gives erh. H 8.8 and says the rim is missing. Preserved height cannot become an unqualified complete object height.','resolved')
item('369.3',2,['Napf'],790,'3',height=3.2)
for rec, typ, a, height, countalt in [('369.4','Tasse',800,13,[799]),('369.5','Hängegefäß',805,12.5,[]),('369.6','Tasse',811,15.4,[]),('369.7','Hängegefäß',819,10.5,[])]:
    item(rec,0,[typ],a,'1',height=height,alternatives=countalt)
    rules[(rec,'grave_goods.0.item_id',json.dumps('1'))] = (False,[],'PDF pp.98–99 describes a single unnumbered vessel in this grave. An object count or first array position is not a source item identifier 1.','resolved')

item('371',0,['Flintmeißel'],846,'1',material='Flint')
item('371',1,['Flintbeil'],848,'2',material='Flint')
item('375.1',0,['KA','Kugelamphore'],880,'1')
item('375.1',1,['Flintbeil'],882,'2',material='Flint')
item('375.1',2,['Flintbeil'],881,'3',material='Flint')
item('375.1',3,['Knochenplatte'],883,'4',material='Knochen')

item('383',0,['Gefäß'],997,'1',alternatives=[996])
item('383',1,['Schweineknochen'],999,'2',count=None)
rules[('383','grave_goods.1.item_id',json.dumps('2'))] = (False,[],'Original PDF p.102 numbers the pig bones 3. Item 2 is human skeletal remains.','resolved')
rules[('383','grave_goods.1.item_type',json.dumps('Schweineknochen',ensure_ascii=False))] = (False,[],'The claim identifies item 2, which is human skeletal remains on PDF p.102. Pig bones are item 3 and additionally identified only by laypeople.','resolved')

item('397',0,['Gefäß','Tasse'],1174,'1',height=12.2)
for typ in ('Gefäß','Tasse'):
    key=('397','grave_goods.0.item_type',json.dumps(typ,ensure_ascii=False))
    rules[key]=(None,[],'PDF pp.104–105 describes sherds probably from one vessel, reconstructed as a Tasse, and explicitly says grave association is not secured; the concluding note considers association probable. Its unqualified status as a grave-good vessel remains unresolved (1173–1175, 1182).','unresolved')
rules[('397','grave_goods.0.item_count','1')] = (False,[],'The source says 17 sherds wohl eines Gefäßes; exact vessel count 1 removes wohl.','resolved')
rules[('397','grave_goods.0.height_value','12.2')] = (False,[],'H 12.2 is explicitly the dimension of the reconstructed vessel, not an unqualified exact original height.','resolved')
rules[('397','grave_goods.0.height_unit',json.dumps('cm'))] = (True,[[1175]],'The reconstruction measurement series explicitly uses cm; this scalar unit remains stated despite uncertain grave association and reconstructed height.','resolved')
item('397',1,['Querschneider'],1177,'3',material='Flint')
for field,value in [('item_id','3'),('item_type','Querschneider'),('item_count',1),('material','Flint')]:
    note = 'Original PDF p.105 numbers the Querschneider 2; item 3 is other sherds, whose quantity is not stated. The claim attaches the object to the wrong source item identifier.'
    if field=='material': note='The source does not state Flint as the material of the Querschneider. It separately describes Flintmaterial as item 4; the claimed item 3 is other sherds. Archaeological material expectation is insufficient.'
    rules[('397','grave_goods.1.'+field,json.dumps(value,ensure_ascii=False))]=(False,[],note,'resolved')

item('398.1',0,['Amphore'],1189,'1',height=14,alternatives=[1190])
rules[('398.1','grave_goods.0.height_value','14')] = (False,[],'The object dimensions begin Maße etwa: H 14; exact height 14 drops the explicit approximation.','resolved')
item('402',0,['Tasse'],1243,'1',height=9.5)
rules[('402','grave_goods.0.item_count','1')] = (True,[[1244,1243]],'The PDF sentence crosses the canonical split: enthielt ein[e] Tasse. This is one explicitly described cup.','resolved')
rules[('402','grave_goods.0.item_id',json.dumps('1'))] = (False,[],'Original PDF p.107 describes one cup without assigning an item number. Count one is not source identifier 1.','resolved')
item('403',0,['Flintbeil'],1253,'1',material='Flint')
rules[('403','grave_goods.0.item_id',json.dumps('1'))] = (False,[],'Original PDF p.107 says lediglich 1 Flintbeil. This is an object quantity, not a numbered item identifier.','resolved')

labels=[]
for c in claims:
    rec=c['recordContext']['catalogue_id']
    path='.'.join(map(str,c['resultPath'][2:]))
    value=c['value']
    if rec=='331' and path.startswith('grave_goods.'):
        if path.endswith('item_type'):
            evidence = [276,277] if value=='Eberhauer' else [276,275]
        else:
            evidence = [276,277] if value==2 else [276]
        verdict=(True,[[x] for x in evidence], 'Source explicitly lists a small vessel and two boar tusks. The array position is not a source ID; the object is identified by its type.', 'resolved')
    else:
        key=(rec,path,json.dumps(value,ensure_ascii=False))
        assert key in rules, (c['claimId'],key)
        verdict=rules[key]
    support,sets,note,status=verdict
    pages=sorted({anchors[i]['page'] for s in sets for i in s})
    where='PDF page'+('s ' if len(pages)>1 else ' ')+','.join(map(str,pages)) if pages else 'Original source'
    labels.append({'claimId':c['claimId'],'valueSupported':support,'goldAnchorSets':[[anchors[i]['anchorId'] for i in s] for s in sets], 'note':f'{where}; catalogue {rec}, {path}: '+(note or f'The passage states {value!r} for this feature/object in its local catalogue context.'),'status':status})

assert len(labels)==597
assert len({x['claimId'] for x in labels})==len(labels)
assert {x['claimId'] for x in labels}=={x['claimId'] for x in claims}
valid={a['anchorId'] for a in anchors}
for x in labels:
    assert x['valueSupported'] in (True,False,None)
    assert x['status'] in ('resolved','unresolved')
    assert x['valueSupported'] is not False or x['goldAnchorSets']==[]
    assert x['valueSupported'] is not None or x['status']=='unresolved'
    assert all(s and len(set(s))==len(s) and set(s)<=valid for s in x['goldAnchorSets'])
(ROOT/'labels-a.json').write_text(json.dumps(labels,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(Counter((x['valueSupported'],x['status']) for x in labels))
print('Unresolved:', ', '.join(x['claimId'] for x in labels if x['status']=='unresolved'))
print('Validated exact 597-ID coverage, uniqueness, anchor existence and support consistency.')
