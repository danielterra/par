// Counters describe connection time, independently for each participant's endpoint.
async function sampleUsage(current) {
  const now = performance.now();
  const month = new Date().toISOString().slice(0, 7);
  if (current.usage?.month !== month) {
    current.usage = { month, direct: 0, turn: 0, unknown: 0 };
    current.usageSample = now;
    current.usageReported = undefined;
  }
  const interval = Math.max(0, now - current.usageSample);
  const elapsed = interval > 15000 ? 0 : interval;
  current.usageSample = now;
  await Promise.all([...links.values()].map(async link => {
    if (link.pc.connectionState !== 'connected') return;
    const pc = link.pc;
    let route = 'unknown';
    try {
      let pair = pc.sctp?.transport.iceTransport?.getSelectedCandidatePair?.();
      if (pair) {
        route = pair.local.type === 'relay' || pair.remote.type === 'relay' ? 'turn' : 'direct';
      } else {
        const stats = await pc.getStats();
        const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
        pair = stats.get(transport?.selectedCandidatePairId);
        if (pair) {
          const local = stats.get(pair.localCandidateId);
          const remote = stats.get(pair.remoteCandidateId);
          if (local?.candidateType && remote?.candidateType) {
            route = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'turn' : 'direct';
          }
        }
      }
    } catch {
      // A connection may close while its statistics are being collected.
    }
    if (current !== session || link.pc !== pc || pc.connectionState !== 'connected') return;
    current.usage[route] += elapsed;
  }));
}

function usageReport(current, force = false) {
  if (!current.usage || (!force && current.usageReported !== undefined &&
      performance.now() - current.usageReported < 30000)) return undefined;
  const usage = { ...current.usage };
  for (const key of ['direct', 'turn', 'unknown']) usage[key] = Math.floor(usage[key]);
  return usage;
}

function usageText(usage) {
  const measured = usage.direct + usage.turn;
  const minutes = value => (value / 60000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const share = measured ? (100 * usage.turn / measured) : null;
  const percent = share === null ? 'Aguardando medição' :
    'TURN ' + share.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% · ' +
    (share > 50 ? 'TURN predominante' : share < 50 ? 'Conexão direta predominante' : 'Uso igual');
  return percent + ' · Direta ' + minutes(usage.direct) + ' min · TURN ' + minutes(usage.turn) +
    ' min · Sem classificação ' + minutes(usage.unknown) + ' min';
}

function renderUsage(current, usage, peers) {
  $('usage-summary').textContent = 'Produto em ' + usage.month + ' — ' + usageText(usage.total);
  const names = new Map(peers.map(peer => [peer.id, peer.name]));
  names.set(current.id, current.name + ' (você)');
  $('usage-people').replaceChildren(...usage.participants.map(participant => {
    const row = document.createElement('li');
    row.textContent = (names.get(participant.participant) ?? 'Participante') + ' — ' + usageText(participant);
    return row;
  }));
}
