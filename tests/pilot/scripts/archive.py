"""Archive each attempt before another Playwright invocation replaces artifacts."""
import os,shutil,sys
run=os.environ.get('PILOT_RUN_ID','p20260919a')
r='artifacts/pilot/'+run
a=r+'/attempts/'+sys.argv[1]
os.makedirs(a,exist_ok=False)
for f in ['test-results','html-report','results.json']:
 if os.path.exists(r+'/'+f):shutil.move(r+'/'+f,a+'/'+f)
