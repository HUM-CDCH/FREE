"""Source review of 9 September 2026, before candidate inference; agent only.

Each scalar is one unit; finds are distinct object classes, not object counts.
Pages refer to the original PDF. Unknown spellings/claims go to blind review.
This module is never imported by an inference adapter.
"""
import copy
from common import DEFAULT_ROOT, DOCS, HERE, read, save, sha


def atom(aliases, pages):
    return {'aliases': aliases.split('|'), 'pages': pages if isinstance(pages, list) else [pages]}


def record(ident, pages, kind, rite, axis, date, finds):
    fields = {'grave_id': [atom(ident + ('|' + ident.removeprefix('Grav ') if ident.startswith('Grav ') else ''), pages)],
              'site_name': [], 'grave_type': [], 'burial_rite': [], 'burial_axis': [], 'dating': [], 'finds': []}
    for name, value in zip(['grave_type', 'burial_rite', 'burial_axis', 'dating'], [kind, rite, axis, date]):
        if value:
            fields[name] = [atom(*value)]
    fields['finds'] = [atom(*value) for value in finds]
    return {'id': ident, 'pages': pages, 'fields': fields}


def build(root):
    references = {'reviewedAt': '2026-09-09', 'reviewer': 'Codex; PDF images and extracted text; no independent human validation',
        'version': 1, 'notes': [
            'Freeze preceded all models-policy-v2 inference. Nulls are not successful supported units.',
            'Finds use one unit per named object class; finer supported descriptions are reviewed without changing previous scores silently.',
            'The Danish-on-Beier-schema arm is a mismatch stress test: German catalogue fields have no support unless their stated cues exist. Its grave inventory is diagnostic, not a deployment gate.',
            'Højbakkegård grave 6 prints contradictory period/date; preserve the printed wording. Body/head directions do not establish a grave axis.',
            'Hvissinge loose bones labelled 7 and 8 lack grave contexts and are excluded. Brøndbylund has no individually identified graves.',
            'Katrinesminde A18/A22 are uncertain graves; include with qualifications. Its thematic prose names all eleven Roman graves; the apparent repeated A5 on page 11 does not remove A25.',
            'Locations initially identify PDF pages; exact canonical Beier passages are provided. Danish links require blind passage adjudication before qualification. Page/crop overlap alone never earns supported-link credit.'
        ], 'documents': {}}
    h = [
        record('A240', [9,10], ('urnegrav|Urnegraven',9), ('urnegrav|Urnegraven',9), None, None,
               [('ornamenteret benkam|benkam',10), ('stort pattedyr|enten kvæg eller hest',9)]),
        record('A225',[10,11,12],('brandpletgrav|Brandpletgraven',10),('brandpletgrav|Brandpletgraven',10),None,
               ('forsigtigt til yngre romersk jernalder/ældre germansk jernalder',12),
               [('mindre hankekop|hankekop|stærkt sintret lille kar', [11,12]),('rød, mat glasperle|glasperle',[11,12])]),
        record('A200',[13,14],('jordfæstegrav|Jordfæstegraven',13),('jordfæstegrav|Jordfæstegraven',13),('omtrentlig Ø-V|omtrentlig Ø-V-orienteret',13),
               ('Ældre Germansk Jernalder (375-550 e.Kr.)|Ældre Germansk Jernalder',14),
               [('uornamenteret skål med hank|skål med hank',14),('sortbrændt, ornamenteret vase|ornamenteret vase|vase',14)]),
    ]
    b = [
        record('Grav 1',[8],('foret med sten|jordfæstegrav',[7,8]),('jordfæstegrave|jordfæstegrav',7),('nordøst-sydvestlig|nordøst-sydvest',8),('senneolitikum',7),[]),
        record('Grav 2',[8],('foret med sten|trækiste',8),('jordfæstegrave|jordfæstegrav',7),None,('formentlig dateres til senneolitikum|formentlig senneolitikum',8),[]),
        record('Grav 11',[9],('urnegrav|fragmenteret urne',[6,9]),('urnegrav|urne',[6,9]),None,('yngre bronzealder',9),[]),
        record('Grav 6',[9],('Jordfæstegrav',9),('Jordfæstegrav',9),('nord - sydvendt|nord-syd',9),('førromersk jernalder per. III (ca. 400 e.Kr.)|førromersk jernalder per. III',9),
               [('lerkar',9),('dyretand',9),('La Têne fibula|fibula',9)]),
        record('Grav 56',[9,10],('Jordfæstegrav|formentlig en barnegrav',9),('Jordfæstegrav',9),('nordøst - sydvest|nordøst-sydvest',9),('yngre romersk jernalder',7),[('lille lerkar|lerkar',10)]),
        record('Grav 87',[10],('Jordfæstegrav|bulkiste',10),('Jordfæstegrav',10),('nord sydvendt|nord-syd',10),('yngre romersk jernalder C1b (ca. 210-250 e.Kr)|yngre romersk jernalder C1b',10),
               [('fibula',10),('sølvfingerring',10),('glasskår',10),('lerkar',10),('benkam',10)]),
        record('Grav 9',[11,12],('Jordfæstegraven|Jordfæstegrav',11),('Jordfæstegraven|Jordfæstegrav',11),('nord - syd vendt|nord-syd',11),('begyndelsen af ældre germansk jernalder|ældre germansk jernalder D',[7,11,12]),
               [('ornamenteret lerkar|lerkar',11),('trelagskam med jernnitter|trelagskam',11),('perlekæde|glas- og ravperler',11),('fibler',12)]),
        record('Grav 86',[12],('Jordfæstegrav|bulkiste',12),('Jordfæstegrav',12),('nord-syd|nord - syd',12),None,[]),
        record('Grav 88',[12],('Jordfæstegrav|formentlig en barnegrav',12),('Jordfæstegrav',12),('nord-syd|nord - syd',12),None,[('lerkar',12)]),
    ]
    v = [
        record('Grav 1',[6,7],('jordfæstegrav|jordfæstegrave',6),('jordfæstegrav|jordfæstegrave',6),None,('romersk jernalder',7),[]),
        record('Grav 2',[7],('jordfæstegrav|jordfæstegrave',6),('jordfæstet',7),None,('ældre romersk jernalder',6),[('lerkar',7),('lille krumbladet kniv af jern|kniv af jern',7)]),
        record('Grav 3',[7,8,9,10],('bådgrav',7),('jordfæstegrav|jordfæstegrave',6),None,('50 til 150 efter vor tidsregning|50 til 150',13),
               [('lerkar',[7,8]),('to lange nåle|nåle',8),('lille stykke blik med gennembrydninger|blik',8),('mulig nagle af jern',8),('tre fibler|fibler',9),('bæltespænde',9),('to halve får|får',7),('hønsestor fugl|hønen',[7,9])]),
        record('Grav 4',[10,11],('jordfæstegrav|jordfæstegrave',6),('jordfæstegrav|jordfæstegrave',6),None,('ældre romersk jernalder',6),
               [('lerkar',10),('stor synål|synål',10),('lille krumkniv i kobberlegering|krumkniv i kobberlegering',10)]),
        record('Grav 5',[11,12],('jordfæstegrav|jordfæstegrave',6),('jordfæstegrav|jordfæstegrave',6),None,('ældre romersk jernalder',6),
               [('lerkar',11),('atten guldfolieperler|18 guldfolieperler|guldfolieperler',11),('tynd nål af kobberlegering|nål af kobberlegering',11)]),
        record('Grav 6',[12,13],('bådgrav',12),('jordfæstegrav|jordfæstegrave',6),None,('100 til 200 efter vor tidsregning|100 til 200',13),
               [('får',12),('fibler (dragtnåle)|fibler',12),('lerkar',12)]),
    ]
    k = [
        record('A18',[8,9],('havde karakter af jordfæstegrave|mulig bådgrav',[8,9]),('havde karakter af jordfæstegrave',8),('omtrent N-S',8),('må de være fra samme periode',[8,9]),[('ca. 30 små flintafslag|flintafslag',8)]),
        record('A22',[8,9],('en grav eller alternativt, en offergrube|grav eller offergrube',9),('havde karakter af jordfæstegrave',8),('omtrent N-S',8),('ældre enkeltgravskultur',9),[('svajet bæger|bæger',9)]),
    ]
    for ident in ['A1','A2','A3','A4','A5','A20','A21','A23','A24','A25','A115']:
        finds = []
        if ident in ['A1','A3','A4','A21']:
            vessels = {'A1':['vase','hankekop','skål','ubestemt kar'], 'A3':['vase','skål','hankekop'], 'A4':['skål','hankekop'], 'A21':['miniature vase|miniaturevase']}[ident]
            finds.extend((x,[18,19]) for x in vessels)
        else:
            finds.append(('lerkar|kar',[15,18]))
        if ident in ['A2','A5','A20','A24','A25']: finds.append(('jernkniv|kniv|knive',12))
        if ident in ['A2','A23']: finds.append(('ringspænde|ringspænder',12))
        if ident in ['A1','A3','A115']: finds.append(('ovalt remspænde|ovale remspænder|remspænde',12))
        if ident == 'A21': finds.append(('jernnål',[13,18]))
        if ident in ['A2','A24','A115']: finds.append(('fibler|fibulae',13))
        if ident in ['A1','A2','A21','A23','A24','A115']: finds.append(('glasperler',[13,14,18,19]))
        if ident in ['A1','A21','A24']: finds.append(('ravperle|ravperler|mulig tenvægt af rav',[14,15,19]))
        if ident == 'A24': finds.extend([('bronzebæltespænde|bronze D-formet bæltespænde',13),('bronzerembeslag',13),('bronzeremendedop',13),('nitter',13),('musling',17),('to mindre sten',17),('rem',17)])
        if ident in ['A2','A24','A115']: finds.append(('offerkar|lerkar ovenpå graven',16))
        k.append(record(ident,list(range(11,22)),('jordfæstegrave|jordfæstegrav',11),('jordfæstegrave|jordfæstegrav',11),
               ('NØ-SV',11) if ident in ['A4','A115'] else ('omtrent Ø-V med en lille drejning mod ØSØ-VNV',11),
               ('ældre romertid',11),finds))
    for doc, rows, site in zip(DOCS[1:], [h,b,v,[],k], ['Herredsvejen','Højbakkegård','Hvissinge Øst','Brøndbylund 3','Katrinesminde']):
        for row in rows: row['fields']['site_name'] = [atom(site,1)]
        references['documents'][doc] = {'sourceSha256':read(root/'inputs'/doc/'baseline/parsed_document.json')['document']['content_sha256'], 'records':rows}
    old = read(HERE.parent/'beier.reference.json')
    source = read(root/'inputs/beier/baseline/parsed_document.json')
    records = []
    for row in old['records']:
        ident = str(row['values'][0])
        fields = {}
        for name, value in zip(old['columns'], row['values']):
            if ident == '228' and name == 'findspot': value = '1. Gleinaer Berg'
            fields[name] = []
            if value is None: continue
            index = row.get('axis' if name == 'burial_axis' else 'fa' if name == 'find_type' else 'map' if name == 'map_sheet' else 'header', row['header'])
            block = source['content_stream'][index]
            anchors = [a for a in source['evidence_index']['anchors'] if a.get('block_id') == block['block_id']]
            fields[name] = [{**atom(str(value),block['page_number']), 'canonicalAnchorIds':[a['anchor_id'] for a in anchors],
                             'passages':[{'page':o['page_number'],'bbox':o['bbox']} for a in anchors for o in a['producer_observations']]}]
        records.append({'id':ident,'pages':sorted({p for items in fields.values() for a in items for p in a['pages']}),'fields':fields})
    references['documents']['beier'] = {'sourceSha256':old['sourceSha256'], 'records':records,
                                        'originalReferenceSha256':sha(HERE.parent/'beier.reference.json')}
    save(root/'references-v1.json',references)
    return references


if __name__ == '__main__':
    build(DEFAULT_ROOT)
