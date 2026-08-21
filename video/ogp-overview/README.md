# OGP overview video — pt-BR

Vídeo explicativo de 120 segundos sobre o Offline Guarantee Protocol. A composição é reproduzível em Remotion e preserva o cronograma original do projeto.

## Entregáveis

- `out/ogp-overview-pt-br.mp4` — render 1920×1080, 30 fps, H.264 + AAC;
- `out/ogp-overview-pt-br.srt` — legendas externas em português;
- `out/ogp-thumbnail.png` — thumbnail 16:9;
- `out/narration-script-pt-br.txt` — texto corrido da narração;
- `data/cues.json` — roteiro cronometrado usado pelo vídeo e pelo SRT.

## Honestidade da apresentação

- as telas móveis são reconstruções visuais baseadas nas interfaces reais dos aplicativos payer e merchant;
- o monitor do protocolo é identificado no próprio vídeo como visualização demonstrativa;
- ele não é apresentado como o dashboard funcional da Sprint 10;
- valores são unidades de teste, não BRL;
- o vídeo não afirma integração com Pix, devnet ou prontidão para produção;
- os resultados técnicos exibidos vêm de evidências versionadas no repositório;
- H4 está concluído e a Sprint 8 permanece em desenvolvimento na data do render.

## Reproduzir

Requisitos:

- Node.js 22.17.0 ou compatível;
- Corepack;
- PowerShell para a alternativa de voz local, ou Python 3.12 + `edge-tts==7.2.7` para regenerar a voz neural.

```powershell
cd video/ogp-overview
$env:CI='true'
corepack pnpm install --frozen-lockfile
node scripts/generate-assets.mjs
corepack pnpm render
corepack pnpm thumbnail
node scripts/verify-output.mjs
```

A trilha `public/audio/ogp-ambient-original.wav` é gerada deterministicamente pelo script local. A narração usada no render foi sintetizada com `pt-BR-FranciscaNeural`; somente o texto público do roteiro foi enviado ao serviço de síntese.

## Estrutura narrativa

1. queda de conexão e problema do gasto duplicado;
2. sessão, colateral e três limites econômicos;
3. troca offline por QR entre pagador e lojista;
4. reconexão e submissão do claim;
5. fork, cobertura e revogação;
6. evidências atuais e limitação experimental;
7. chamada para o repositório público.
