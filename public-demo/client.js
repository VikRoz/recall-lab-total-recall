// Local presentation controls only. No network, credentials, model or storage writes.
(() => {
  const buttons = [...document.querySelectorAll('[data-stage]')];
  const panels = [...document.querySelectorAll('.stage-panel')];
  function selectStage(index) {
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    panels.forEach((panel, i) => { panel.hidden = i !== index; });
  }
  buttons.forEach((button, i) => button.addEventListener('click', () => selectStage(i)));
  selectStage(0);
  const search = document.getElementById('memory-search');
  const filter = document.getElementById('memory-filter');
  const records = [...document.querySelectorAll('[data-record]')];
  function filterRecords() {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    records.forEach(record => {
      const matchesType = filter.value === 'all' || (filter.value === 'fixture'
        ? record.dataset.source === 'fixture' : record.dataset.kind === 'correction');
      record.hidden = !(matchesType && record.dataset.search.includes(query));
      if (!record.hidden) count++;
    });
    document.getElementById('record-count').textContent = `Показано ${count} из ${records.length} записей`;
    document.getElementById('empty-records').hidden = count !== 0;
  }
  search.addEventListener('input', filterRecords);
  filter.addEventListener('change', filterRecords);
  document.getElementById('download-data').addEventListener('click', () => {
    const data = JSON.parse(document.getElementById('demo-data').textContent);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'RecallLab-Saved-Evidence.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
