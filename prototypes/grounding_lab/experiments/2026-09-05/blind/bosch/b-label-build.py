import json
from pathlib import Path

base = Path(__file__).parent
claims = json.loads((base / 'claims.json').read_text(encoding='utf-8-sig'))
anchors = json.loads((base / 'anchors.json').read_text(encoding='utf-8-sig'))
byid = {c['claimId']: c for c in claims}
labels = {}

def put(ids, *sets, note=None, support=True, status='resolved'):
    for number in ids.split():
        cid = 'c' + number.zfill(4)
        assert cid in byid and cid not in labels, cid
        c = byid[cid]
        loc = c.get('recordContext', {}).get('catalogue_id', 'title page')
        pages = sorted({anchors[i]['page'] for s in sets for i in s})
        detail = note or ('The local source explicitly supports this attribute; numeric rendering and grammatical inflection are normalized without changing the assertion.')
        labels[cid] = dict(claimId=cid, valueSupported=support,
            goldAnchorSets=[[anchors[i]['anchorId'] for i in s] for s in sets],
            note=f'Catalogue {loc}; PDF page(s) {", ".join(map(str, pages)) or "see rationale"}. {detail}', status=status)

# Record identifiers: headings themselves are sufficient; no routine heading
# attachment is made to attribute evidence.
heads = {'1':34,'2':54,'3.1':83,'3.2':101,'4':116,'5':149,'6.1':170,'6.2':182,
 '7.1':195,'7.2':214,'7.3':235,'7.4':249,'7.5':274,'7.6':287,'7.7':299,
 '7.8':312,'7.9':322,'7.11':345,'7.12':363,'7.13':377,'7.14':388}
grave_mentions = {'1':[36],'2':[58],'3.1':[88],'3.2':[102],'5':[154],
 '6.1':[171],'6.2':[183],'7.1':[201],'7.2':[215],'7.3':[236],
 '7.4':[250],'7.5':[275],'7.6':[288],'7.7':[300],'7.8':[313],
 '7.9':[323],'7.11':[346,369,373],'7.12':[347,368],
 '7.13':[378],'7.14':[389]}
for c in claims:
    if c['resultPath'][-1] in ('catalogue_id','site','district','grave_id'):
        cat = c['recordContext']['catalogue_id']
        alternatives = [[heads[cat]]]
        if c['resultPath'][-1]=='grave_id':
            alternatives += [[i] for i in grave_mentions[cat]]
        put(c['claimId'][1:], *alternatives,
            note='The record heading states the catalogue ID, named site, district and, where present, feature/grave identifier. Suffixes are retained. Attribute support is separate from record-selection eligibility.')

put('44',[2],note='The PDF title page names Tobias Ludwig Bosch as the author.')
put('128',[0],note='The PDF title page states this dissertation title.')
put('183',[6],[3],note='The title page explicitly dates the work 2008; this is not taken from its filename. The separate examination date is 2009.')

# 1 Aiterhofen, Grab 1.
put('16 64',[36],note='Grab 1 is explicitly 0.8 m deep.')
put('121 286 345 392',[35],note='Grabgrube dimensions are explicitly 1.7 x 0.9 m.')
put('199 343',[40],note='The source explicitly identifies one male individual in Grab 1.')
put('108 242',[40,41],note='The buried male is described as a linker Hocker; the sentence is split across canonical anchors.')
put('315',[41],note='The same burial has its head in the north.')
put('93 425',[47],[42],note='Item 2 is stated as cup sherds; Henkeltasse is a more specific cup description.')
put('282 318',[51],[43],note='The source preserves the grouped identifier 4–12 for eight pebbles and one sandstone; no count is calculated.')
put('325 399',[49],[42])
put('363',[45],[41,42],note='The inventory labels the bone pendant as item 1; its narrative item marker follows the split noun phrase.')
put('371',[45])
put('418',[45],[41,42])

# 2 Altdorf, Grab 2. PDF p4 resolves the canonical reading-order shuffle.
put('6 53 152 191 279 372',[60],note='PDF p4 confirms the rearranged canonical sentence: one male who died in young years, buried as a left crouched inhumation with head NNE. The age wording remains qualitative.')
put('34 233 240 344',[58],note='Grab 2 pit dimensions are explicitly 1.55 x 1.0 m.')
put('8 436',[67],[63])
put('61',[67])
put('32 430',[76],[63])
put('56 266 403',[74],[64,65],note='Four Silexpfeilspitzen, grouped 6–9, are explicitly stated; not derived from the identifier range.')
put('104 236 338',[71],[65],note='Three Eberhauer, grouped 2–4, are explicitly stated.')
put('361 378',[73],[64])

# 3.1 Atting, Befund 4777.
put('11',[95],[90])
put('14',[96],note='The dagger description explicitly gives Plattenhornstein; PDF p5 confirms the displaced continuation belongs to this item.')
put('79',[90],[94,95],note='The narrative explicitly marks the Silexdolch (3); inventory number and type are split canonically.')
put('90 278',[93],[90])
put('129 144 244 312 313',[88],note='Befund 4777 explicitly contains one male, left crouched, head north; this directly describes an inhumation.')
put('148',[92],[89])
put('395',[89],note='The narrative explicitly labels the pendant (1); the inventory numeral is missing canonically.')
put('422',[92])

# 3.2 Atting, Befund 4799.
put('19',[111])
put('40 281 288',[109],[104],note='The source explicitly records two cups with grouped ID 10–11.')
put('80 150 232 259 297',[102],note='One male is explicitly buried as a left crouched inhumation with head NNW.')
put('92 411',[108],[103,104],note='The inventory identifies Schale 9; its narrative type and item number cross a canonical line break.')
put('164 362',[110],[104])
put('168 186 217',[107],[103],note='Eight pendants and their grouped ID 1–8 are explicitly stated.')
put('176 383',[111],[105])
put('352',[107])

# 4 Aufhausen cremation.
put('73 133 374 381',[117],note='The explicitly stated grave-pit dimensions are 2.20 x 1.20 m.')
put('112 178',[118],note='The source explicitly calls this a Brandschüttungsgrab and gives the pit axis NW–SE; it does not assert a certain head direction.')
put('143 221',[130],note='The source explicitly refers to the male individual; only the proposed head location is qualified as conjectural.')
put('94',[132],note='The narrative identifies Armschutzplatte (5); PDF p6 confirms the inventory numeral lost from canonical text.')
put('113 180 270 291',[133],note='Two gold sheets (9–10) are explicitly stated, preserving the group.')
put('120',note='PDF p6, Aufhausen: Eberzahn is explicitly specified for pendants 1 and 2, but the fragments of at least one further pendant (3) have no stated material. Applying Eberzahn to the complete 1–3 group is unsupported.',support=False)
put('146',[142])
put('172 370 426',[144],[133],note='Two Silexpfeilspitzen (7–8) are explicit.')
put('214 289 419',[143],[133])
put('252',[141],[132])
put('321 423',[131],note='The narrative explicitly groups remnants of at least three pendants as 1–3; no exact item_count is asserted here.')
put('409',[132])
put('415',[142],[132])

# 5 Augsburg-Haunstetten, Grab 4.
put('1',[167],[161])
put('20 60 98 196 437',[154],note='The source gives pit 1.65 x 0.8 m and depth 0.6–0.7 m. The metre unit is explicit even though an exact midpoint depth would be unsupported.')
put('67 82 234 248 306 360',[159],note='The source explicitly describes one early-adult male inhumation, left crouched, head north.')
put('84 156 263',[160],note='The narrative explicitly states two pendants grouped 1–2.')
put('135',note='PDF p6 gives depth 0.6–0.7 m, not 0.65 m. The claimed number is a calculated midpoint of the range.',support=False)
put('192',[164,165],note='Both individually described pendants 1 and 2 explicitly have Eberzahn material; the combined group requires both descriptions, confirmed on PDF p7.')
put('230',[161],note='The narrative marks the Silexabschlag (4); its inventory numeral is missing in canonical text.')
put('302',[166])
put('314',[166],[161])
put('354',[161],[166],note='Armschutzplatte is identified as item 3 in the narrative and in the inventory plate reference, which the catalogue convention maps to item numbers.')

# 6.1 Barbing Grab 3.
put('17 222 223',[178],[171])
put('25 228',[174],note='The Glockenbecher explicitly has H. 11.8 cm.')
put('37',[171],note='The narrative explicitly identifies the additional sherd as item 4; the corresponding inventory numeral is absent canonically.')
put('43 161',[179],[171],note='Four Silexpfeilspitzen are explicitly stated.')
put('75 432',[174],[171])
put('99',[177])
put('123 163 197 227 229 424',[171],note='Grab 3 explicitly contains one certainly male, mature individual as a left crouched skeleton, head NE. The confidence wording is affirmative, not an omitted uncertainty.')
put('166',[176],[171])
put('218',[175],[171])
put('253 328',[173],[171])
put('264',[179],note='Grouped 7–10 is intact in the inventory; the narrative canonical OCR concatenates it to 710, so that occurrence is not accepted for the grouped ID.')
put('292 407',[177],[171])
put('309',[173])
put('366',[171],note='The narrative explicitly identifies the Henkeltöpfchen sherds as item 3.')

# 6.2 Barbing Grab 7.
put('5 255',[189],[186])
put('47 57 83 190 280',[183],note='The source explicitly describes one left crouched individual, head NE, retaining the sex qualification vermutlich männlich.')
put('76 241',[189],note='The beaker height is explicitly 9.3 cm.')
put('188 225 235',[191],[186],note='The source records copper wire ornament (2), now decayed. The item type/material remain source-stated despite its indirect preservation.')

# 7.1 Burgweinting Obj. 2010.
put('78 131 215 364 387 401',[204],note='The source explicitly identifies one late-adult–mature male inhumation, left crouched, with head approximately north; the orientation qualification is retained.')
put('114 330',[209],[207])
put('142 209',[211],[207])
put('145 276 301 369',[201],note='The initial pit dimensions are explicitly 2.5 x 1.2 m; the smaller Planum 2 measurements are different observations.')

# 7.2 Burgweinting Obj. 2011.
put('33 211 298 350',[215],note='The initial pit dimensions are explicitly 2.26 x 1.29 m.')
put('38 72',[230],[221,222],note='The inventory identifies Silexkratzer 3; narrative type and marker continue on the next anchor.')
put('65 284',[229],[221])
put('96 184',[225],[220])
put('111',[225])
put('125 158 206 269 394',[217],note='One adult male is explicitly described in a left crouched burial.')
put('179 237',[231],[221])
put('376',[217,218],note='The statement of head orientation continues from Kopf im to Nordosten across these anchors.')

# 7.3 Burgweinting Obj. 2012.
put('7 245 275 351',[236],note='The initial pit dimensions are explicitly 2.26 x 1.06 m.')
put('50 140 268 431',[237],note='The text explicitly describes one adult male Rücken-/Rückenhocker burial.')
put('59',[237,238],note='PDF p9 confirms Rückenhocker with both head and legs laid toward the right; both split canonical anchors are necessary for the full position.')
put('63',[238])
put('147 353',[246],[242])
put('171 250',[245],[242])
put('256 348',[244],[241])

# 7.4 Burgweinting Obj. 3080.
put('21 29 246 433',[253],note='This describes the primary early-juvenile male and his left crouched inhumation; a second child is separately reported.')
put('22 231',[269],[258],note='The pendant and its item marker 4 are explicit; the inventory describes three fragments of one pendant.')
put('86 153',[267],[260])
put('127 305 308 358',[250],note='The initial pit dimensions are explicitly 2.17 x 1.2 m, distinct from the inner discoloration.')
put('151',[257],note='The source explicitly identifies a second individual, a child, in addition to the primary juvenile; this is direct count evidence, not inferred from grave goods.')
put('204 388',[265],[260])
put('287 356',[263],[260])
put('296',[253,254],note='The orientation statement continues from Kopf to im Norden across the two anchors.')
put('300',[269])

# 7.5 Burgweinting Obj. 3081.
put('95 115 175',[277],note='The source identifies one Infans I individual and explicitly qualifies sex as eher männlich.')
put('107 334 391 420',[275],note='The initial pit dimensions are explicitly 1.52 x 0.85 m.')
put('118 258',[284],[281])
put('137 331',[283],[281])
put('368',[276,277],note='The source identifies the deceased through surviving tooth crowns of the otherwise decayed skeleton; the inhumation is supported independently of uncertain reconstructed posture.')
put('375 379',note='PDF p10, Obj. 3081: wurde vermutlich als linker Hocker mit dem Kopf im Norden bestattet. Vermutlich qualifies the reconstructed posture and head orientation; the claim omits it.',support=False)

# 7.6 Burgweinting Obj. 3082.
put('27 277 349 438',[290],note='The source explicitly identifies the poorly preserved skeleton of one Infans II individual, eher männlich; inhumation is supported independently of uncertain posture.')
put('48 97',[294],[292])
put('110 116 136 138',[288],note='The initial pit dimensions are explicitly 1.53 x 1.02 m.')
put('200 262',[296],[292])
put('393 414',note='PDF p10, Obj. 3082: wurde vermutlich als linker Hocker mit dem Kopf im Norden bestattet. The reconstructed posture and orientation are qualified as probable; the claim removes that uncertainty.',support=False)

# 7.7 Burgweinting Obj. 3083.
put('55',note='PDF p10, Obj. 3083 says vermutlich mit dem Kopf im Süden bestattet. A certain head-south claim drops the explicit uncertainty.',support=False)
put('87 408',[308],[304])
put('119 359',[309],note='The source gives item 2 as Becher (Krug?), preserving the question and alternative rather than flattening it to a certain jug.')
put('169 203 224 327',[300],note='The initial pit dimensions are explicitly 1.02 x 0.7 m.')
put('187 212 400',[302],note='The source explicitly identifies one Infans I individual, eher weiblich.')
put('290',[301,302],note='The otherwise decayed skeleton with surviving teeth directly supports an inhumation; its head orientation is separately uncertain.')

# 7.8 Burgweinting Obj. 3084.
put('41 219',[318],[343,316],note='Inventory Silexklinge 1 is explicit; the PDF confirms the displaced narrative prefix Eine Silexklinge belongs before (1) fand sich am Rücken.')
put('70 88 220 337',[313],note='The initial pit dimensions are explicitly 2.14 x 1.15 m.')
put('101 267 285 294 397',[315],note='The source explicitly describes one adult inhumation, left crouched, head north.')
put('130 417',[319],[316])
put('406',[314],note='The source explicitly qualifies the sex as eher männlich.')

# 7.9 Burgweinting Obj. 3085.
put('3',[325],note='The local text explicitly records the poorly preserved skeleton; inhumation is supported independently of conjectural head orientation.')
put('10 336',[331],[329],note='Inventory item 1 is a small cup; the narrative Tassen (1–2) is a grouped alternative identifying both cups.')
put('49 173 261',[327],note='The source explicitly identifies one Infans I individual, eher männlich.')
put('51 126 193 333',[323],note='The initial pit dimensions are explicitly 1.76 x 1.15 m.')
put('66 201',[334],[329])
put('122 435',[335],[332],note='Both the inventory and displaced narrative continuation explicitly identify Schale (3); PDF p11 verifies its local reading order.')
put('185',note='PDF p11, Obj. 3085: wurde vermutlich mit dem Kopf im Norden bestattet. The claim drops the explicit orientation uncertainty.',support=False)

# 7.11 Burgweinting Obj. 3087a; suffix preserved.
put('9 18',[360],[354])
put('68 154',[356],[352],note='Item 1 is explicitly a Tasse; the narrative grouped 1–2 is an alternative for the individual cup identifier.')
put('71 182',[357],[352],note='Item 2 is explicitly a larger Tasse; the narrative grouped 1–2 is an alternative for the individual cup identifier.')
put('155 247 342 373',[346],[369],note='Both the 3087a description and the comparison inside 3087b explicitly assign 1.93 x 1.15 m to 3087a.')
put('189 295 357 398',[349],note='The primary individual is explicitly late-adult, right crouched, head south.')
put('239 402',[358],[352])
put('316',note='PDF p12, Obj. 3087a names one female skeleton but also undetermined calcined bones in the bowl, including probably a skull fragment. Whether these represent another person is not settled; an exact total individual_count of 1 cannot be resolved from the source.',support=None,status='unresolved')
put('428',[348],note='The source explicitly identifies the primary individual as female.')

# 7.12 Burgweinting Obj. 3087b.
put('23 105 141 205 365 389',[371],note='The source explicitly describes one juvenile, eher männlich, as a left crouched inhumation with head NNW.')
put('162 260 283 429',[347],[364,365,366,367,368],note='The comparison in Obj. 3087a explicitly gives 3087b as 2.09 x 0.9 m. PDF p12 confirms the same measurements in 3087b; that alternative is fragmented into five canonical anchors.')

# 7.13 Burgweinting Obj. 3088.
put('36 216 249 390',[378],note='The initial pit dimensions are explicitly 1.67 x 1.08 m.')
put('103 159',[381])
put('132',[379],note='The source explicitly describes the poorly preserved skeleton in this grave.')
put('181 251 380',[380],note='The source explicitly identifies one adult individual, eher weiblich.')

# 7.14 Burgweinting Obj. 3089. Attribute support and first-20 eligibility remain separate.
put('2 377',[399],[394])
put('26 74',[398],[394],note='PDF p13 confirms the canonical inventory phrase with Taf. 18,2 belongs to item 2, also explicit in the narrative.')
put('69',[390],note='The source explicitly qualifies sex as eher weiblich; the record-selection limit is a separate question.')
put('85 347 367 386',[389],note='The initial pit dimensions are explicitly 2.17 x 0.91 m; record eligibility is separate from attribute support.')
put('89 174 274 310 404',[391],note='The source explicitly describes one adult inhumation, right crouched, head south; record eligibility is separate from attribute support.')
put('382 405',[396],[394])

assert len(byid) == len(claims) == 438
assert set(labels) == set(byid), {'missing':sorted(set(byid)-set(labels)), 'extra':sorted(set(labels)-set(byid))}
valid_ids = {a['anchorId'] for a in anchors}
for label in labels.values():
    assert label['valueSupported'] in (True,False,None)
    assert label['status'] in ('resolved','unresolved')
    assert label['valueSupported'] is not False or not label['goldAnchorSets']
    assert label['valueSupported'] is not None or label['status']=='unresolved'
    assert all(s and len(s)==len(set(s)) and set(s)<=valid_ids for s in label['goldAnchorSets'])
    assert len({tuple(sorted(s)) for s in label['goldAnchorSets']})==len(label['goldAnchorSets'])
ordered = [labels[c['claimId']] for c in claims]
(base / 'labels-b.json').write_text(json.dumps(ordered,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'total':len(ordered),'supported':sum(x['valueSupported'] is True for x in ordered),'unsupported':sum(x['valueSupported'] is False for x in ordered),'unresolved':[x['claimId'] for x in ordered if x['status']=='unresolved']},indent=2))
