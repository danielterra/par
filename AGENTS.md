# Par

O aplicativo fica em `par/` e as funções do Cloudflare Pages em `functions/par/`. O repositório público é `danielterra/par`. A produção fica em `https://danielterra.com.br/par/`.

## Desenvolvimento

- Para rodar localmente, use `wrangler pages dev . --d1 PAR_ROOMS=par-rooms-local` e abra `/par/`.
- Valide os scripts com `node --input-type=module --check < caminho/do/arquivo.js`. Teste com duas abas quando mudar sala, sinalização, WebRTC ou chat.
- Mantenha credenciais fora do Git. O D1 guarda apenas dados de presença e sinalização. Mensagens, mídia e arquivos são enviados via WebRTC.

## Release

1. Termine os testes, faça o commit em `main` e envie o branch ao GitHub.
2. Escolha a próxima versão SemVer e crie uma tag anotada no commit aprovado. Por exemplo, `git tag -a v1.0.1 -m "Par v1.0.1"`.
3. Envie a tag com `git push origin v1.0.1`. O workflow **Validar release do Par** valida a versão e publica a release no GitHub.
4. O workflow **Publicar** no repositório privado `danielterra/danielterra.com.br` verifica as releases a cada 5 minutos e publica a versão mais alta validada no Cloudflare Pages. O agendamento do GitHub pode atrasar. Para iniciar imediatamente, execute esse workflow manualmente no repositório privado após a release aparecer.
5. Confira o workflow privado, a versão em `https://danielterra.com.br/par/version.txt` e a criação de uma sala no endereço público.

Commits em `main` do Par só chegam à produção depois de uma tag e release validadas. Em caso de regressão, reverta o commit problemático em `main` e publique uma nova versão. Preserve as tags já publicadas.
