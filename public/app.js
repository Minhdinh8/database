async function load() {
  const cfg = await fetch('/api/config').then(r=>r.json());
  document.getElementById('trackedChannels').value = (cfg.trackedChannelIds||[]).join(',');
  document.getElementById('displayChannel').value = cfg.displayChannelId || '';
  document.getElementById('interval').value = cfg.updateIntervalMinutes || 30;

  refreshEntries();
}

async function refreshEntries(){
  const data = await fetch('/api/tracked').then(r=>r.json());
  const el = document.getElementById('entries');
  el.innerHTML = '';
  el.appendChild(document.createTextNode('Total entries: ' + (data.entries?.length||0)));
}

document.getElementById('save').addEventListener('click', async ()=>{
  const trackedChannelIds = document.getElementById('trackedChannels').value.split(',').map(s=>s.trim()).filter(Boolean);
  const displayChannelId = document.getElementById('displayChannel').value.trim();
  const updateIntervalMinutes = parseInt(document.getElementById('interval').value,10) || 30;
  const body = { trackedChannelIds, displayChannelId, updateIntervalMinutes };
  const resp = await fetch('/api/config', { method:'POST', headers: { 'Content-Type':'application/json', 'x-user-id': '' }, body: JSON.stringify(body) });
  if (resp.ok) alert('Saved'); else alert('Failed to save; check server logs');
});

document.getElementById('scan').addEventListener('click', async ()=>{
  const resp = await fetch('/api/triggerScan', { method:'POST', headers: { 'Content-Type':'application/json', 'x-user-id': '' } });
  if (resp.ok) alert('Triggered'); else alert('Failed');
});

load();
