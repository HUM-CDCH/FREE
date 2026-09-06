import json,re
from pathlib import Path
p=Path(__file__).parent
claims=json.loads((p/'claims.json').read_text(encoding='utf-8-sig'))
anchors=json.loads((p/'anchors.json').read_text(encoding='utf-8-sig'))
out=[]
def judge(c,idx=None,note=None,support=True,sets=None):
    if sets is None: sets=[] if idx is None else [[idx]]
    r=c['recordContext']['catalogue_id']; f=c['resultPath'][-1]
    pg=anchors[sets[0][0]]['page'] if sets else '?'
    out.append(dict(claimId=c['claimId'],valueSupported=support,goldAnchorSets=[[anchors[i]['anchorId'] for i in s] for s in sets] if support else [],note=note or f'PDF p.{pg}, catalogue {r}: {f} is stated in this local source passage.',status='resolved'))
def no(c,note): judge(c,note=f"Catalogue {c['recordContext']['catalogue_id']}: {note}",support=False)
base={
'311':dict(catalogue_id=63,site=63,burial_type=64,findspot_id=66,discovery_year=67,construction_type=68,orientation=69,chamber_length_value=69,chamber_length_unit=69,chamber_width_unit=69),
'316':dict(catalogue_id=116,site=116,burial_type=117,findspot_id=118,discovery_year=119,construction_type=120,orientation=120,body_position=122,individual_count=122,chamber_length_value=122,chamber_length_unit=122,chamber_width_value=122,chamber_width_unit=122),
'331':dict(catalogue_id=271,site=271,burial_type=272,discovery_year=274,orientation=276,construction_type=276,individual_count=276,pit_depth_unit=276),
'356':dict(catalogue_id=519,site=519,burial_type=520,discovery_year=522,pit_depth_unit=523,construction_type=523),
'363':dict(catalogue_id=602,site=602,burial_type=603,findspot_id=604,discovery_year=605,orientation=608,construction_type=608,chamber_length_value=608,chamber_length_unit=608,chamber_width_unit=608),
'364.4':dict(catalogue_id=715,site=654,burial_type=716,grave_id=716,findspot_id=656,discovery_year=657,pit_depth_value=718,pit_depth_unit=718,construction_type=717),
'371':dict(catalogue_id=842,site=842,discovery_year=845,construction_type=847),
'375.1':dict(catalogue_id=877,site=875,findspot_id=876,discovery_year=878,burial_type=879,body_position=879,pit_depth_value=879,pit_depth_unit=879,individual_count=879),
'383':dict(catalogue_id=992,site=992,findspot_id=994,body_position=996,individual_count=996),
'397':dict(catalogue_id=1170,site=1170,findspot_id=1172,discovery_year=1173,burial_type=1171,construction_type=1173),
'398.1':dict(catalogue_id=1188,site=1184,burial_type=1185,findspot_id=1186,discovery_year=1187,grave_id=1190,construction_type=1190,orientation=1190,chamber_length_value=1190,chamber_length_unit=1190,chamber_width_unit=1190),
'402':dict(catalogue_id=1239,site=1239,burial_type=1240,grave_id=1244,construction_type=1244,orientation=1244,chamber_length_value=1244,chamber_length_unit=1244,chamber_width_unit=1244),
'403':dict(catalogue_id=1248,site=1248,burial_type=1249,grave_id=1253,construction_type=1253),
}
sch={1:(766,768,769),2:(776,777,779),3:(785,786,788),4:(797,798,799),5:(804,806,805),6:(810,813,811),7:(817,819,819)}
for n,(cat,grave,body) in sch.items():
    base[f'369.{n}']=dict(catalogue_id=cat,site=761,grave_id=grave,findspot_id=763,discovery_year=764,individual_count=body,construction_type=769,burial_type=body)
bad={('311','chamber_width_value'):'PDF p.1 gives width 0.8–0.9 m, not an exact 0.8.',('316','sex'):'PDF pp.1–2 assigns different qualified sexes to skulls a and b; combining them into the shared sex field conflates individuals, contrary to frozen instructions.',('316','age_class'):'PDF p.2 assigns different ages to a and b; shared age_class conflates two individuals.',('331','pit_depth_value'):'PDF p.3 states about 1 m depth; exact 1 discards etwa.',('356','pit_depth_value'):'PDF p.5 states T etwa 1.2 m; exact 1.2 removes qualification.',('363','chamber_width_value'):'PDF p.6 gives west width 1.1–1.2 m and east width about 1.5 m, not exact 1.1.',('375.1','grave_id'):'PDF pp.9–10 identifies catalogue subentry 375.1 and source category (1), but does not name a grave 1; catalogue suffix is not a grave ID.',('383','discovery_year'):'PDF p.11 says middle of the 1950s, not exact year 1955.',('397','orientation'):'PDF p.12 states O-W ?; the value drops explicit uncertainty.',('397','individual_count'):'PDF p.12 says at least 3 individuals; an exact count of 3 discards the lower-bound qualification.',('398.1','chamber_width_value'):'PDF p.12 gives width 0.6–0.8 m, not exact 0.6.',('402','discovery_year'):'PDF p.13 states 1937?; exact 1937 drops uncertainty.',('402','chamber_width_value'):'PDF p.13 gives width 0.4–0.5 m, not exact 0.4.'}
for c in claims:
    r=c['recordContext']['catalogue_id']; f=c['resultPath'][-1]; v=c['value']; ctx=c['context'] or ''
    if len(c['resultPath'])==3:
        if (r,f) in bad: no(c,bad[(r,f)]); continue
        if r.startswith('369.') and f=='burial_type' and v=='Gräberfeld':
            no(c,'PDF p.8 calls the entire site a Gräberfeld; this record is one separately identified skeleton grave, not itself a cemetery.'); continue
        if r=='371' and f=='burial_type': judge(c,843 if v=='Grab' else 847); continue
        if r=='383' and f=='burial_type':
            if v=='Grab': judge(c,993)
            else: no(c,'PDF p.11 says offenbar Flachgrab, so the unqualified string Flachgrab drops source uncertainty.')
            continue
        judge(c,base[r][f]); continue
    item=re.search(r'item_id: ([^,]+)',ctx)
    item=item.group(1) if item else (str(v) if f=='item_id' else None)
    if r=='331':
        if 'Eberhauer' in ctx or v=='Eberhauer' or v==2:
            judge(c,sets=[[276],[277]],note='PDF p.3, catalogue 331: both the burial description and item passage explicitly state 2 boar tusks.')
        else: judge(c,276)
    elif r=='356':
        idx=524 if item=='a' else 526
        if f=='height_value' and v==26: no(c,'PDF p.5 gives reconstructed H 26; bare numeric height loses the reconstruction qualification.')
        else: judge(c,idx)
    elif r=='363':
        if f=='item_type' and v=='Knochen': no(c,'PDF p.6 describes human skeletal remains, not a Knochen grave-good item; human remains cannot be reassigned to grave_goods.')
        elif f=='item_count': judge(c,sets=[[608],[609]],note='PDF p.6, catalogue 363: one grinding stone/plate is explicitly described in the finding narrative and singular object entry.')
        else: judge(c,609)
    elif r=='364.4':
        idx={'1':719,'2':721,'3':722,'4':723,'5':724,'6':725}[item]
        if item=='1' and f in ('height_value','height_unit'): idx=720
        if item=='6' and f=='item_id': judge(c,718)
        else: judge(c,idx,note=f'PDF pp.7–8, catalogue 364.4, object {item}: source description and original list marker support this attribute; vessel 6 has explicitly uncertain association with the burial, separate from the stated object attribute.' if item=='6' else None)
    elif r=='369.1':
        if f=='item_id' and item in ('2','3'): no(c,'PDF p.8 numbers Steinaxt as 2 and Schleifstein as 3; claimed item ID reverses their original source numbering.')
        else:
            typ=v if f=='item_type' else ('Schleifstein' if 'Schleifstein' in ctx else ('Steinaxt' if 'Steinaxt' in ctx else 'Hängegefäß'))
            idx={'Schleifstein':771,'Steinaxt':772,'Hängegefäß':770}[typ]
            if f=='item_count': judge(c,sets=[[769],[idx]],note='PDF p.8, catalogue 369.1: singular object is stated in narrative and its descriptive entry; sibling item ID is an assertion and is not used as evidence.')
            else: judge(c,idx)
    elif r=='369.2':
        if item=='1':
            idx=780 if f in ('height_value','height_unit') else 778
        else: idx=782
        judge(c,idx)
    elif r=='369.3':
        idx={'1':787,'2':789,'3':790}[item]
        if item=='2' and f=='height_value': no(c,'PDF p.8 states erh. H 8.8 and a missing rim; 8.8 is preserved height, not an unqualified complete height.')
        else: judge(c,idx)
    elif r in ('369.4','369.5','369.6','369.7'):
        idx={'369.4':800,'369.5':805,'369.6':811,'369.7':819}[r]
        if f=='item_id': no(c,'PDF p.9 describes one unnumbered vessel. The source does not assign item identifier 1; a count or array index cannot supply an ID.')
        elif r=='369.4' and f=='item_count': judge(c,sets=[[799],[800]])
        else: judge(c,idx)
    elif r=='371': judge(c,846 if item=='1' else 848)
    elif r=='375.1':
        if item=='1': judge(c,880)
        elif item=='4': judge(c,883)
        elif f=='item_id': judge(c,882 if item=='2' else 881,note=f'PDF p.10 numbers the small axe 2 and the thin-bladed axe 3. Both sibling contexts say only Flintbeil and are compatible with their original IDs; canonical local list markers retain numbering.')
        else: judge(c,sets=[[881],[882]],note='PDF p.10, catalogue 375.1: two separately listed singular flint axes support the generic object type/material/count; sibling context provides no differentiating description beyond its claimed identifier.')
    elif r=='383':
        if f=='item_id' and v=='2': no(c,'PDF p.11 lists the pig bones as item 3; item 2 is human skeletal remains.')
        elif f=='item_type' and v=='Schweineknochen': no(c,'PDF p.11 qualifies pig-bone identification as only determined by laypeople; the plain string omits that express source qualification.')
        elif f=='item_count': judge(c,sets=[[996],[997]])
        else: judge(c,997)
    elif r=='397':
        if item=='3':
            if f=='item_id': no(c,'PDF p.12 numbers Querschneider 2; source item 3 is additional pottery sherds.')
            elif f=='material': no(c,'PDF p.12 names Querschneider but does not state Flint for it. Separate item 4 Flintmaterial cannot establish material for this item.')
            else: judge(c,1177,note='PDF p.12, catalogue 397: one Querschneider is stated. Source warns that association of finds with burial is not secure; this attribute labels the listed object only.')
        elif f=='height_value': no(c,'PDF p.12 gives dimensions of a reconstructed vessel, H 12.2; bare exact height discards the reconstruction qualification.')
        elif f=='item_count': no(c,'PDF p.12 says 17 sherds wohl eines Gefäßes; exact vessel count 1 drops uncertainty about whether all belong to one vessel.')
        elif f=='item_type' and v=='Tasse': no(c,'PDF p.12 reconstructs the sherds as a Tasse; plain Tasse omits the reconstruction qualification.')
        elif f=='item_type': judge(c,1174,note='PDF p.12, catalogue 397: vessel sherds are explicitly described; source membership and single-vessel reconstruction remain uncertain.')
        elif f=='item_id': judge(c,1174)
        else: judge(c,1175)
    elif r=='398.1':
        if f=='height_value': no(c,'PDF p.12 states Maße etwa H 14; exact 14 drops approximation.')
        else: judge(c,1189)
    elif r=='402':
        if f=='item_id': no(c,'PDF p.13 describes an unnumbered cup; source assigns no item identifier 1.')
        else: judge(c,1243)
    elif r=='403':
        if f=='item_id': no(c,'PDF p.13 states 1 Flintbeil as a count, not a numbered inventory-item identifier.')
        else: judge(c,1253)
    else: raise AssertionError(c)
assert len(out)==len(claims)==597
assert len({x['claimId'] for x in out})==len(out)
assert {x['claimId'] for x in out}=={x['claimId'] for x in claims}
aid={a['anchorId'] for a in anchors}
assert all(all(a in aid for s in x['goldAnchorSets'] for a in s) for x in out)
assert all(x['valueSupported'] is not False or not x['goldAnchorSets'] for x in out)
(p/'labels-b.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
from collections import Counter
print(Counter(x['valueSupported'] for x in out));print('unresolved', [x['claimId'] for x in out if x['status']=='unresolved'])
