#!/usr/bin/env python3
"""作品文首插圖處理：壓縮並以作品編號命名放進 artwork/。

用法：
    /usr/bin/python3 tools/add_artwork.py <圖檔路徑> <作品id>

會輸出 artwork/<作品id>.jpg（寬 ≤1080、品質 82）。之後 git add/commit/push，
部署鏈全自動（Pages＋兩鏡像），推完即生效。移除插圖＝刪檔重推。
"""
import sys, os
from PIL import Image

def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(1)
    src, nid = sys.argv[1], sys.argv[2].strip()
    if len(nid) < 30 or ' ' in nid:
        print(f"✗ 作品id 看起來不對：{nid!r}（應為 UUID）"); sys.exit(1)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    im = Image.open(src).convert('RGB')
    im.thumbnail((1080, 4000), Image.LANCZOS)
    out = os.path.join(repo, 'artwork', f'{nid}.jpg')
    im.save(out, quality=82)
    print(f"✓ artwork/{nid}.jpg  {im.size[0]}x{im.size[1]}  {os.path.getsize(out)//1024}KB")
    print("接著：git add artwork && git commit && git push（部署全自動）")

if __name__ == '__main__':
    main()
