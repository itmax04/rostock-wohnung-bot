"""Генерирует src/districts.js из GeoJSON с границами районов Ростока.

Источник границ: OpenStreetMap (admin_level=10), выгружены через polygons.openstreetmap.fr.
Использование: python3 scripts/build_districts.py data/rostock-bezirke.geojson src/districts.js
Районы в файле — те, что раньше были выбраны для поиска; сейчас они используются только для
подписи района и пометки приоритета ⭐ (на отбор квартир не влияют).
"""
import json
import sys


def main(src: str, out: str) -> None:
    fc = json.load(open(src, encoding='utf-8'))
    districts = []
    for feature in fc['features']:
        ring = [[round(x, 5), round(y, 5)] for x, y in feature['geometry']['coordinates'][0]]
        districts.append({'name': feature['properties']['name'], 'ring': ring})
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write('// Границы выбранных районов Ростока (OpenStreetMap, admin_level=10), [lon, lat].\n')
        fh.write('export const DISTRICTS = ' + json.dumps(districts, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print(f'{len(districts)} districts -> {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
