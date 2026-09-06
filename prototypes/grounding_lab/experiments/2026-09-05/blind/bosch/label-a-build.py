import json
from pathlib import Path

base = Path(__file__).parent
claims = json.loads((base / 'claims.json').read_text(encoding='utf-8-sig'))
anchors = json.loads((base / 'anchors.json').read_text(encoding='utf-8-sig'))
judgments = {}

def put(ids, sets, note='', supported=True, status='resolved'):
    if isinstance(sets, int):
        sets = [[sets]]
    for cid in ids.split():
        cid = 'c' + cid.zfill(4)
        assert cid not in judgments, cid
        judgments[cid] = (supported, sets, note, status)

def no(ids, note):
    put(ids, [], note, False)

# Each assignment below is a manual source judgment. Numbers are anchor-array
# positions, translated to immutable anchor IDs only when serializing.
put('44', 2, 'Title page explicitly names Tobias Ludwig Bosch.')
put('128', 0, 'Title page states this title.')
put('183', [[3], [6]], 'Title page dates this volume to 2008; the 2009 examination date is separate.')

# 1. Aiterhofen, Grab 1, PDF page 4.
put('31 45 273 416', 34)
put('16 64', 36)
put('121 286 345 392', 35)
put('108', [[40,41]])
put('315', 41)
put('343 199', 40, 'One male individual is explicitly introduced as ein männliches Individuum.')
put('242', [[40,41]], 'The male deceased is bodily buried as a left croucher, supporting inhumation.')
put('93 425', [[42],[47]])
put('282 318', [[43],[51]])
put('325 399', [[42],[49]])
put('363 418', [[45],[41,42]])
put('371', 45)

# 2. Altdorf, Grab 2, PDF page 4. PDF confirms scrambled canonical line 60.
put('28 157 384 421', 54)
put('34 233 240 344', 58)
put('6 53 152 279 372', 60, 'PDF p4 confirms the reordered canonical sentence: young male, left croucher, head north-northeast.')
no('191', 'PDF p4 describes the individual in the singular but states no individual count; the protocol forbids inferring a numeric count.')
put('8 436', [[67],[63]])
put('61', 67)
put('32 430', [[76],[63]])
put('104 236 338', [[71],[65]])
put('56 266', [[74],[64,65]])
put('403', [[74],[64,65]])
put('361 378', [[73],[64]])

# 3.1. Atting Aufeld, Befund 4777, PDF p5.
put('134 139 307 319', 83)
put('129 144 244 313', 88, 'An explicitly stated male individual is buried as a left croucher, head north.')
put('312', [[88,89]], 'The explicitly described bodily burial supports inhumation.')
put('11', [[95],[90]])
put('14', 96, 'PDF p5 confirms the split Silexdolch/Plattenhornstein passage belongs to item 3.')
put('79', [[90],[94,95]])
put('90 278', [[93],[90]])
put('148', [[92],[89]])
put('395', 89, 'PDF p5 shows list item 1; the canonical narrative retains its item number.')
put('422', 92)

# 3.2. Atting Aufeld, Befund 4799, PDF p5.
put('4 35 257 323', 101)
put('80 232 259 150', 102, 'One male individual is explicitly introduced and its crouched position and direction stated.')
put('297', [[102,103]], 'The text explicitly describes a bodily burial.')
put('19 176 383', 111)
put('40 281 288', [[109],[104]])
put('92 411', [[108],[103,104]])
put('164 362', [[110],[104]])
put('168 186 217', [[107],[103]])
put('352', 107)

# 4. Aufhausen, PDF pp5-6.
put('52 58 329', 116)
put('73 133 374 381', 117)
put('112 178', 118)
put('143', 130, 'The qualification betrifft the reconstructed head location; male sex itself is stated.')
no('221', 'PDF p6 refers to the male individual but gives no explicit total individual count; do not infer a numeric count from singular reference.')
no('120', 'PDF p6 specifies Eberzahn for items 1 and 2, but gives no material for the further fragmentary pendant item 3. The grouped material claim 1–3 overgeneralizes.')
put('94', 132, 'The narrative explicitly identifies the armschutzplatte as item 5; its list number was dropped canonically.')
put('146 415', 142)
put('113', [[133],[145,146]])
put('180 270 291', 133, 'The narrative explicitly states two gold sheets numbered 9–10.')
put('172 370 426', [[144],[133]])
put('214 419', [[143],[133]])
put('289', 133)
put('252', [[141],[132]])
put('409', 132)
put('321 423', 131, 'The narrative explicitly identifies remnants of at least three pendants as 1–3; no exact item count is claimed here.')

# 5. Augsburg-Haunstetten, Grab 4, PDF pp6-7.
put('42 124 213 226', 149)
put('20 60 98 196 437', 154)
no('135', 'PDF p6 explicitly gives depth 0.6–0.7 m. 0.65 is an inferred midpoint; uncertain/range numeric measurements must be null.')
put('67 82 234 248 306', 159)
no('360', 'PDF p6 describes the male individual in the singular but states no individual count; the protocol forbids inferring a numeric count.')
put('1', [[161],[167]])
put('230', 161)
put('84 156 263', 160)
put('192', [[164,165]], 'Both numbered pendants are explicitly of Eberzahn; PDF p7 confirms the omitted list numbers 1 and 2.')
put('302', 166)
put('314', [[166],[161]])
put('354', 161)

# 6.1. Barbing, Grab 3, PDF p7.
put('100 170 332 396', 170)
put('123 163 197 227 229 424', 171, 'The paragraph explicitly identifies a skeleton from one sicher männlichen, maturen individual and its bodily burial.')
put('17 222', [[178],[171]])
put('223', 171)
put('25 228', 174)
put('75', [[174],[171]])
put('432', 171)
put('37', 171)
put('166', [[176],[171]])
put('43 161 264', [[179],[171]])
put('99', 177)
put('292', [[177],[171]])
put('407', 171)
put('218', [[175],[171]])
put('366', 171)
put('253', 171)
put('309', 173)
put('328', [[173],[171]])

# 6.2. Barbing, Grab 7, PDF p8.
put('24 54 194 265', 182)
put('47 57 280', 183)
put('190', [[183,184]], 'The stated left-crouched burial supports inhumation even though sex is qualified.')
no('83', 'PDF p8 refers to the presumably male individual but states no numeric individual count; singular reference is not an explicit count.')
put('5 255', [[189],[186]])
put('76 241', 189)
put('188 225 235', [[191],[186,187]])

# 7.1. Burgweinting, Obj. 2010, PDF p8.
put('202 339 340 346', 195)
put('145 276 301 369', 201)
put('78 131 215 387 401', 204)
no('364', 'PDF p8 describes the individual in the singular but gives no explicit individual count.')
put('114 330', [[209],[207]])
put('142 209', [[211],[207]])

# 7.2. Burgweinting, Obj. 2011, PDF pp8-9.
put('15 165 198 326', 214)
put('33 211 298 350', 215)
put('125 158 206', 217)
put('376', [[217,218]])
put('394', [[217,218]])
no('269', 'PDF p8 describes the male individual but states no explicit total individual count.')
put('38 72', [[230],[222]])
put('65 284', [[229],[221]])
put('96 184', [[225],[220]])
put('111', 225)
put('179 237', [[231],[221]])

# 7.3. Burgweinting, Obj. 2012, PDF p9.
put('81 160 195 335', 235)
put('7 245 275 351', 236)
put('59', [[237,238]])
put('63', 238)
put('140', [[237,238]])
put('268 431', 237)
no('50', 'PDF p9 describes the male individual but states no explicit total individual count.')
put('147 353', [[246],[242]])
put('171 250', [[245],[242]])
put('256 348', [[244],[241]])

# 7.4. Burgweinting, Obj. 3080, PDF pp9-10.
put('12 106 208 355', 249)
put('127 305 308 358', 250)
put('21 29 433', 253)
put('296', [[253,254]])
put('246', [[253,254]])
put('151', 257, 'The text expressly identifies a second individual (a child); the count two is explicit through that ordinal in the local burial context.')
put('22 231', [[269],[258]])
put('300', 269)
put('86 153', [[267],[260]])
put('204 388', [[265],[260]])
put('287 356', [[263],[260]])

# 7.5. Burgweinting, Obj. 3081, PDF p10.
put('102 207 311 324', 274)
put('107 334 391 420', 275)
put('115 175', 277)
put('368', [[276,277]], 'The text explicitly calls this a skeleton in the grave; only its reconstructed posture/direction is qualified.')
no('375 379', 'PDF p10 says vermutlich als linker Hocker mit dem Kopf im Norden: the emitted unqualified position/direction loses the stated uncertainty.')
no('95', 'PDF p10 describes the individual but states no explicit individual count.')
put('118 258', [[284],[281]])
put('137 331', [[283],[281]])

# 7.6. Burgweinting, Obj. 3082, PDF p10.
put('299 341 412 434', 287)
put('110 116 136 138', 288)
put('27 277 438', 290, 'The text explicitly identifies an actual skeleton and the qualified male Infans II individual.')
no('393 414', 'PDF p10 says vermutlich als linker Hocker mit dem Kopf im Norden; the claim drops the uncertainty affecting reconstructed posture/direction.')
no('349', 'PDF p10 describes the individual but gives no explicit total individual count.')
put('48 97', [[294],[292]])
put('200 262', [[296],[292]])

# 7.7. Burgweinting, Obj. 3083, PDF pp10-11.
put('149 210 303 317', 299)
put('169 203 224 327', 300)
put('212 400', 302)
put('290', [[301,302]], 'The actual skeleton is described as almost entirely decayed; this is an inhumation, with head orientation separately qualified.')
no('55', 'PDF p10 explicitly says vermutlich mit dem Kopf im Süden; unqualified south orientation is stronger than the source.')
no('187', 'PDF p10 describes the individual but does not explicitly state an individual count.')
put('87 408', [[308],[304]])
put('119', [[309],[304]])
put('359', 309, 'The item retains the source qualification Becher (Krug?).')

# 7.8. Burgweinting, Obj. 3084, PDF p11.
put('46 117 304 427', 312)
put('70 88 220 337', 313)
put('101 267 285 294', 315)
put('406', 314)
no('397', 'PDF p11 describes the individual in the singular but does not explicitly state a total individual count.')
put('41', [[318],[343,316]], 'PDF p11 confirms displaced Eine Silexklinge continues into the narrative item (1).')
put('219', [[318],[343,316]])
put('130 417', [[319],[316]])

# 7.9. Burgweinting, Obj. 3085, PDF p11.
put('13 62 254 413', 322)
put('51 126 193 333', 323)
put('49 261', 327)
put('3', 325, 'The source explicitly describes the skeleton in this grave.')
no('185', 'PDF p11 reads wurde vermutlich mit dem Kopf im Norden bestattet; the emitted orientation omits vermutlich.')
no('173', 'PDF p11 describes the individual but gives no explicit total individual count.')
put('10 336', [[331],[329]])
put('66 201', [[334],[329]])
put('122 435', [[335],[332]])

# 7.11. Burgweinting, Obj. 3087a, PDF p12.
put('109 320 322 385', 345)
put('155 247 342 373', [[346],[369]])
put('189 295 357 398', 349)
put('428', [[348,349]])
no('316', 'PDF p12 describes a woman and additionally undetermined calcined remains, including a possible skull fragment; no total individual count is stated and one cannot be inferred.')
put('9 18', [[360],[354]])
put('68 154', [[356],[352]])
put('71 182', [[357],[352]])
put('239 402', [[358],[352]])

# 7.12. Burgweinting, Obj. 3087b, PDF p12.
put('167 271 272 293', 363)
put('23 105 205 365 389', 371)
put('162 260', [[347],[364,366,367]], 'Both the adjacent 3087a paragraph and the split local 3087b passage explicitly state the relevant metres.')
put('283', [[347],[364,366]], 'PDF p12 confirms 0.9 is the width of 3087b; the fragmented canonical local passage preserves the dimension relationship.')
put('429', [[347],[364]], 'Both catalogue passages explicitly give the 3087b pit length 2.09 m.')
no('141', 'PDF p12 describes the individual but states no explicit total individual count.')

# 7.13. Burgweinting, Obj. 3088, PDF p12.
put('91 238 243 410', 377)
put('36 216 249 390', 378)
put('103 159', 381)
put('181 251', 380)
put('132', [[380,381]])
no('380', 'PDF p12 describes the individual but gives no explicit total individual count.')

# 7.14. Burgweinting, Obj. 3089, PDF p13.
put('30 39 77 177', 388, 'This identity is source-stated; eligibility or first-20 selection is a separate question.')
put('85 347 367 386', 389)
put('69', 390)
put('174 274 310 404', 391)
no('89', 'PDF p13 describes the individual but gives no explicit total individual count.')
put('2 377', [[399],[394]])
put('26', 394, 'The canonical list omits item 2 but the narrative explicitly retains its number; PDF p13 confirms it.')
put('74', [[398],[394]])
put('382 405', [[396],[394]])

assert len(judgments) == len(claims), (len(judgments), len(claims), sorted(set(c['claimId'] for c in claims)-judgments.keys()))
assert set(judgments) == {c['claimId'] for c in claims}
result = []
for c in claims:
    supported, sets, note, status = judgments[c['claimId']]
    canonical = [[anchors[i]['anchorId'] for i in group] for group in sets]
    rc = c.get('recordContext') or {}
    identity = (str(rc.get('catalogue_id','')) + ' ' + str(rc.get('site','')) + ' ' + str(rc.get('grave_id',''))).strip()
    if not note:
        pages = sorted({anchors[i]['page'] for group in sets for i in group})
        note = 'PDF page(s) ' + ', '.join(map(str,pages)) + ': source explicitly supports this field and value in the cited local passage.'
    if identity:
        note = identity + ': ' + note
    result.append(dict(claimId=c['claimId'], valueSupported=supported, goldAnchorSets=canonical, note=note, status=status))

ids = [r['claimId'] for r in result]
valid = {a['anchorId'] for a in anchors}
assert len(ids) == len(set(ids)) == 438
assert all(a in valid for r in result for group in r['goldAnchorSets'] for a in group)
assert all(r['valueSupported'] is not False or r['goldAnchorSets'] == [] for r in result)
assert all(r['status'] in ('resolved','unresolved') for r in result)
(base / 'labels-a.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'total': len(result), 'supported': sum(r['valueSupported'] is True for r in result), 'unsupported': sum(r['valueSupported'] is False for r in result), 'unresolved': [r['claimId'] for r in result if r['status']=='unresolved']}, indent=2))
