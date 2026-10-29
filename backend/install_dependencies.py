"""Install pinned wheels with sequential HTTPS index fallback and safe progress.

Used by desktop setup and the manual PowerShell launchers. No global pip config
is changed; do not combine --extra-index-url repositories into one resolution.
"""
import json
import argparse
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent
SOURCES = json.loads((ROOT / 'python-sources.json').read_text('utf-8'))['indexes']
ALLOWED = {'requirements.txt','requirements-openvino.txt','requirements-ocr.txt','requirements-asr.txt','requirements-pdf.txt','requirements-homr.txt','requirements-copista.txt','requirements-matchmaker.txt'}


def redact(text):
    def url(match):
        try:
            parsed=urlsplit(match.group())
            return urlunsplit((parsed.scheme, parsed.hostname or '', parsed.path, '', ''))
        except ValueError:
            return '[URL]'
    text=re.sub(r'https?://[^\s<>"\']+',url,str(text),flags=re.I)
    text=re.sub(r'(?i)authorization\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+','Authorization: [redacted]',text)
    text=re.sub(r'(?i)(authorization\s*[:=]\s*|bearer\s+|(?:password|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+',r'\1[redacted]',text)
    return text[:2000]


def emit(event,**data):
    print(json.dumps(dict(event=event,**data),ensure_ascii=False),flush=True)


def stop_process(child):
    if os.name=='nt' and getattr(child,'pid',None):
        try:
            subprocess.run([str(Path(os.environ.get('SystemRoot','C:/Windows'))/'System32/taskkill.exe'),'/PID',str(child.pid),'/T','/F'],
                           stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                           creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=10,check=False)
        except (OSError,subprocess.TimeoutExpired): child.kill()
    else: child.kill()


def preferred_sources(preferred='auto', custom_index=''):
    if preferred not in ['auto','pypi','tuna','ustc','custom']: raise ValueError('invalid-source')
    sources=list(SOURCES)
    if preferred=='custom':
        parsed=urlsplit(custom_index)
        if len(custom_index)>2048 or parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('invalid-source')
        sources.insert(0,dict(id='custom',url=custom_index))
    elif preferred!='auto':
        sources.sort(key=lambda source: source['id']!=preferred)
    return sources


def install(requirements, popen=subprocess.Popen, report=emit, timeout=480, preferred='auto', custom_index=''):
    file=Path(requirements).resolve()
    if file.parent != ROOT or file.name not in ALLOWED or not file.is_file():
        raise ValueError('invalid-requirements')
    environment={k:v for k,v in os.environ.items() if not k.upper().startswith('PIP_')}
    environment.update(PIP_CONFIG_FILE=os.devnull,PYTHONUTF8='1',PYTHONNOUSERSITE='1')
    for index,source in enumerate(preferred_sources(preferred,custom_index)):
        report('source',source=source['id'],attempt=index+1)
        args=[sys.executable,'-m','pip','--isolated','install','--disable-pip-version-check','--only-binary=:all:',
              '--no-warn-script-location','--no-input','--progress-bar','off','--no-color','--retries','0','--timeout','12',
              '--index-url',source['url'],'-r',str(file)]
        child=popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                    encoding='utf-8',errors='replace',bufsize=1,env=environment,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        lines=queue.Queue(maxsize=256)
        def read_output():
            try:
                for line in child.stdout:
                    lines.put(line)
            finally:
                lines.put(None)
        reader=threading.Thread(target=read_output,daemon=True);reader.start()
        deadline=time.monotonic()+timeout
        expired=False
        while True:
            try:
                line=lines.get(timeout=min(1,max(.01,deadline-time.monotonic())))
                if line is None: break
                if line.strip():report('log',text=redact(line.rstrip()))
            except queue.Empty:
                pass
            if time.monotonic()>=deadline:
                expired=True;stop_process(child);break
        try: child.wait(timeout=10 if expired else max(.01,deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            expired=True;stop_process(child)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                report('error',error='process-timeout');return False
        child.stdout.close()
        if child.returncode==0 and not expired:
            report('complete',source=source['id']);return True
        report('log',text='Source attempt timed out.' if expired else 'Source attempt failed; trying the next HTTPS index.')
    report('error',error='network');return False


if __name__=='__main__':
    try:
        parser=argparse.ArgumentParser()
        parser.add_argument('requirements')
        parser.add_argument('--source',default='auto',choices=['auto','pypi','tuna','ustc','custom'])
        parser.add_argument('--custom-index',default='')
        args=parser.parse_args()
        sys.exit(0 if install(args.requirements,preferred=args.source,custom_index=args.custom_index) else 1)
    except (ValueError,IndexError):
        emit('error',error='invalid-requirements');sys.exit(2)
