const fileLimit = 25 * 1024 * 1024;
const fileBudget = 100 * 1024 * 1024;
const fileChunk = 16 * 1024;
const fileTimeout = 60000;

function fileName(name) {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180) || 'arquivo';
}

function fileRow(author, title, status) {
  const item = appendMessage(author, title);
  const detail = document.createElement('div');
  detail.className = 'file-status';
  detail.textContent = status;
  item.append(detail);
  return { item, detail };
}

function filePacket(link, packet) {
  try {
    link.channel.send(JSON.stringify(packet));
    return true;
  } catch {
    return false;
  }
}

function finishFile(link, direction, status) {
  const transfer = link[direction];
  if (!transfer) return;
  link[direction] = undefined;
  clearTimeout(transfer.timer);
  transfer.actions?.remove();
  transfer.detail.textContent = status;
  if (transfer.chunks) transfer.current.fileBytes -= transfer.size;
}

function cancelFile(link, direction, status) {
  const transfer = link[direction];
  if (!transfer) return;
  filePacket(link, { type: direction === 'incomingFile' ? 'file-reject' : 'file-abort', id: transfer.id });
  finishFile(link, direction, status);
}

function armFileTimer(link, direction) {
  const transfer = link[direction];
  clearTimeout(transfer.timer);
  transfer.timer = setTimeout(() => cancelFile(link, direction, 'Transferência expirou.'), fileTimeout);
}

function closeFileTransfers(link) {
  finishFile(link, 'incomingFile', 'Transferência interrompida.');
  finishFile(link, 'outgoingFile', 'Transferência interrompida.');
}

function receiveFileOffer(current, link, packet) {
  if (link.incomingFile || typeof packet.name !== 'string' ||
      !Number.isSafeInteger(packet.size) || packet.size < 0 || packet.size > fileLimit) {
    filePacket(link, { type: 'file-reject', id: packet.id });
    return;
  }
  const name = fileName(packet.name);
  const row = fileRow(link.name, 'Arquivo: ' + name,
    (packet.size / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' MB');
  const actions = document.createElement('div');
  actions.className = 'file-actions';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = 'Receber';
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'secondary';
  reject.textContent = 'Recusar';
  actions.append(accept, reject);
  row.item.append(actions);
  const transfer = { ...row, current, actions, id: packet.id, name, size: packet.size, bytes: 0 };
  link.incomingFile = transfer;
  armFileTimer(link, 'incomingFile');
  accept.onclick = () => {
    if (link.incomingFile !== transfer || transfer.chunks || !isOpen(link)) return;
    if ((current.fileBytes ?? 0) + transfer.size > fileBudget) {
      cancelFile(link, 'incomingFile', 'Limite de arquivos nesta aba atingido.');
      return;
    }
    transfer.chunks = [];
    current.fileBytes = (current.fileBytes ?? 0) + transfer.size;
    accept.remove();
    reject.textContent = 'Cancelar';
    transfer.detail.textContent = 'Recebendo…';
    if (!filePacket(link, { type: 'file-accept', id: transfer.id })) {
      finishFile(link, 'incomingFile', 'Transferência interrompida.');
      return;
    }
    armFileTimer(link, 'incomingFile');
  };
  reject.onclick = () => cancelFile(link, 'incomingFile', transfer.chunks ? 'Transferência cancelada.' : 'Arquivo recusado.');
  markUnread();
}

function receiveFileChunk(link, data) {
  const transfer = link.incomingFile;
  if (!transfer?.chunks) return;
  if (!data.byteLength || data.byteLength > fileChunk || transfer.bytes + data.byteLength > transfer.size) {
    cancelFile(link, 'incomingFile', 'Arquivo inválido.');
    return;
  }
  transfer.chunks.push(data);
  transfer.bytes += data.byteLength;
  transfer.detail.textContent = 'Recebendo… ' + Math.floor(100 * transfer.bytes / transfer.size) + '%';
  armFileTimer(link, 'incomingFile');
}

function completeIncomingFile(link, transfer) {
  if (!transfer.chunks || transfer.bytes !== transfer.size) {
    cancelFile(link, 'incomingFile', 'Arquivo incompleto.');
    return;
  }
  const url = URL.createObjectURL(new Blob(transfer.chunks, { type: 'application/octet-stream' }));
  transfer.chunks = undefined;
  const downloads = transfer.current.fileDownloads ??= new Set();
  downloads.add(url);
  finishFile(link, 'incomingFile', 'Arquivo recebido.');
  const actions = document.createElement('div');
  actions.className = 'file-actions';
  const download = document.createElement('a');
  download.href = url;
  download.download = transfer.name;
  download.textContent = 'Baixar';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary';
  remove.textContent = 'Remover';
  remove.onclick = () => {
    URL.revokeObjectURL(url);
    downloads.delete(url);
    transfer.current.fileBytes -= transfer.size;
    transfer.item.remove();
  };
  actions.append(download, remove);
  transfer.item.append(actions);
  filePacket(link, { type: 'file-done', id: transfer.id });
}

async function sendFileChunks(link, transfer) {
  const { channel, file } = transfer;
  const active = () => link.outgoingFile === transfer && link.channel === channel && isOpen(link);
  try {
    for (let offset = 0; offset < file.size; offset += fileChunk) {
      while (active() && channel.bufferedAmount > 256 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (!active()) throw new Error();
      const chunk = await file.slice(offset, offset + fileChunk).arrayBuffer();
      if (!active()) throw new Error();
      channel.send(chunk);
      transfer.detail.textContent = 'Enviando… ' + Math.floor(100 * (offset + chunk.byteLength) / file.size) + '%';
      armFileTimer(link, 'outgoingFile');
    }
    if (!active() || !filePacket(link, { type: 'file-end', id: transfer.id })) throw new Error();
    transfer.ended = true;
    transfer.detail.textContent = 'Aguardando confirmação…';
    armFileTimer(link, 'outgoingFile');
  } catch {
    if (link.outgoingFile === transfer) cancelFile(link, 'outgoingFile', 'Transferência interrompida.');
  }
}

function handleFilePacket(current, link, packet) {
  if (typeof packet.id !== 'string' || !/^[0-9a-f-]{36}$/.test(packet.id)) return;
  if (packet.type === 'file-offer') {
    receiveFileOffer(current, link, packet);
    return;
  }
  const outgoing = link.outgoingFile;
  if (outgoing?.id === packet.id) {
    if (packet.type === 'file-accept' && !outgoing.started) {
      outgoing.started = true;
      void sendFileChunks(link, outgoing);
    }
    if (packet.type === 'file-reject') finishFile(link, 'outgoingFile', 'Arquivo recusado ou cancelado.');
    if (packet.type === 'file-done' && outgoing.ended) finishFile(link, 'outgoingFile', 'Arquivo entregue.');
  }
  const incoming = link.incomingFile;
  if (incoming?.id === packet.id) {
    if (packet.type === 'file-end') completeIncomingFile(link, incoming);
    if (packet.type === 'file-abort') finishFile(link, 'incomingFile', 'Envio cancelado.');
  }
}

$('attach').onclick = () => $('file-input').click();
$('file-input').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !session) return;
  if (file.size > fileLimit) {
    notice('O limite é de 25 MB por arquivo.');
    return;
  }
  const connected = [...links.values()].filter(isOpen);
  const recipients = connected.filter(link => !link.outgoingFile);
  if (!recipients.length) {
    notice('Aguarde uma conexão disponível para enviar o arquivo.');
    return;
  }
  if (recipients.length < connected.length) notice('O convite foi enviado a quem está disponível para receber arquivos.');
  const name = fileName(file.name);
  for (const link of recipients) {
    const row = fileRow(session.name + ' (você)', name + ' → ' + link.name, 'Aguardando aceitação…');
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Cancelar';
    actions.append(button);
    row.item.append(actions);
    const transfer = { ...row, actions, id: crypto.randomUUID(), channel: link.channel, file };
    link.outgoingFile = transfer;
    button.onclick = () => cancelFile(link, 'outgoingFile', 'Envio cancelado.');
    if (filePacket(link, { type: 'file-offer', id: transfer.id, name, size: file.size })) {
      armFileTimer(link, 'outgoingFile');
    } else {
      finishFile(link, 'outgoingFile', 'Transferência interrompida.');
    }
  }
};
