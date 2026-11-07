#!/usr/bin/env bash
# اجرای دستی چرخهٔ کریپتویار روی گیت‌هاب اکشنز + انتظار برای نتیجه
set -u
REPO="kazemimohammad2310-sys/cryptoyar"
TOKEN=$(git -C /home/z/my-project remote get-url origin | sed -n 's|https://\([^@]*\)@.*|\1|p')
if [ -z "$TOKEN" ]; then echo "NO_TOKEN"; exit 1; fi

BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "dispatch at $BEFORE"
CODE=$(curl -s -o /tmp/dispatch.out -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/actions/workflows/cycle.yml/dispatches" \
  -d '{"ref":"main"}')
echo "dispatch HTTP: $CODE"
if [ "$CODE" != "204" ]; then cat /tmp/dispatch.out | head -5; exit 1; fi

# انتظار برای ظاهر شدن ران تازه (حداکثر ۹۰ ثانیه)
RUN_ID=""
for i in $(seq 1 18); do
  sleep 5
  RUN_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$REPO/actions/runs?per_page=5" | \
    bun -e "const d=await new Response(Bun.stdin.stream()).text();try{const j=JSON.parse(d);const t=new Date('$BEFORE').getTime();const r=(j.workflow_runs||[]).find(x=>new Date(x.created_at).getTime()>=t-5000);console.log(r?String(r.id):'')}catch(e){console.log('')}")
  [ -n "$RUN_ID" ] && break
done
if [ -z "$RUN_ID" ]; then echo "RUN_NOT_FOUND"; exit 1; fi
echo "RUN_ID: $RUN_ID"

# انتظار برای پایان ران (حداکثر ۶ دقیقه)
for i in $(seq 1 36); do
  sleep 10
  OUT=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID" | \
    bun -e "const d=await new Response(Bun.stdin.stream()).text();try{const j=JSON.parse(d);console.log(j.status+' '+(j.conclusion||'-'))}catch(e){console.log('parse-err')}")
  echo "poll $i: $OUT"
  case "$OUT" in completed*) break;; esac
done
echo "FINAL: $OUT"
