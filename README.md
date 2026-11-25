# Par

Sala temporária de até oito pessoas em https://danielterra.com.br/par/. Cada navegador envia texto, voz, câmera e tela via WebRTC. O Pages usa D1 para apresentar os participantes e entregar as ofertas e respostas da conexão.

1. Informe seu nome, escolha uma foto de perfil se quiser e clique em **Criar sala**. Nome e miniatura são reutilizados nesse navegador. A foto segue para os participantes pela conexão WebRTC e fica apenas na memória das abas deles.
2. Clique em **Compartilhar** ou copie o endereço que apareceu na barra do navegador. O mesmo link serve para todos.
3. Quem abrir o convite escolhe o nome e clica em **Entrar na sala**. O palco mostra uma foto ou iniciais quando a câmera está desligada. O menu **Participantes** no cabeçalho mostra os nomes e estados da conexão.
4. Na tela de outro participante, use **Tela cheia** para ampliar ou **Sair da tela cheia** para voltar.
5. Para transmitir o som da captura, marque a opção de áudio no seletor de compartilhamento, quando oferecida. A barra mostra **Tela + áudio** quando o navegador inclui o som. As opções disponíveis dependem do navegador, do sistema e da fonte escolhida.

No celular, use **Chamada** e **Chat** para alternar entre o palco e as mensagens. O contador do chat indica mensagens novas enquanto você está na chamada.

No chat, use o clipe para oferecer um arquivo de até 25 MB aos participantes conectados. Quem aceitar pode baixar ou remover o arquivo. Os arquivos passam pelo WebRTC e ficam temporariamente na aba de quem recebe.

Use **Participantes** para ajustar o volume de cada pessoa. O botão de alto-falante no cartão ou na tela compartilhada silencia aquela pessoa apenas para você.

Use a seta ao lado de **Microfone** ou **Câmera** para escolher o dispositivo. **Atualizar lista** pode solicitar permissão para mostrar os nomes dos dispositivos.

O Par tenta restabelecer a conexão quando ela cai ou quando uma transmissão ativa deixa de chegar. A câmera e a tela voltam se o navegador ainda estiver capturando essas fontes.

A sala fica disponível por até 12 horas. Convites da versão anterior devem ser gerados novamente. O D1 guarda a presença e as mensagens técnicas de sinalização. As mensagens de conversa e a mídia passam pelo WebRTC e o histórico fica na página até sair.

O Par tenta uma conexão direta e pode usar Cloudflare Realtime TURN como reserva. Quando o WebRTC escolhe o retransmissor, o indicador mostra **via TURN**. A função `/par/turn` emite credenciais temporárias com um limite por IP no firewall.

Em produção, configure o vínculo D1 `PAR_ROOMS` e os segredos `PAR_TURN_KEY_ID` e `PAR_TURN_KEY_TOKEN` no Pages. O banco de sinalização é inicializado ao criar a primeira sala. Para testar localmente, execute `wrangler pages dev . --d1 PAR_ROOMS=par-rooms-local` na raiz do site e abra `/par/`.

Consulte [AGENTS.md](AGENTS.md) para o processo de release por tag.

Em **Participantes → Uso de TURN**, consulte o percentual mensal do produto e o tempo de cada participante presente na sala. A métrica soma o tempo de cada conexão de cada participante, com meses em UTC. Uma pessoa conectada a três outras durante um minuto soma três minutos. Ambos os lados reportam seu próprio tempo.

A coleta começa na versão v1.1.0. Os navegadores amostram as conexões aproximadamente a cada dois segundos e enviam totais cumulativos a cada 30 segundos, junto à sinalização. Reenvios usam o maior total recebido para evitar duplicação. Períodos sem rota identificada aparecem separadamente e são excluídos do percentual. Abas suspensas e encerramentos abruptos podem deixar lacunas. Os dados são informados pelo cliente e servem como estimativa de uso, não como medição de faturamento.

O D1 mantém totais por mês, sala e identificador aleatório de participação, sem copiar o nome para a tabela de métricas. A interface mostra nomes apenas dos participantes ainda presentes. O total mensal agregado é visível para participantes autenticados em uma sala. O tempo acumulado de uma participação continua no total depois que ela sai.
