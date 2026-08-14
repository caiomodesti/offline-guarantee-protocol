# Sprint 7 — teste físico dos APKs standalone

Este roteiro é o gate final da Sprint 7. Ele usa dois APKs de preview com o bundle JavaScript embutido. Nenhum servidor Expo, Metro, QR de desenvolvimento ou computador deve ser necessário para abrir os aplicativos.

> Os APKs são previews assinados com a chave de desenvolvimento gerada no build. Servem apenas para a validação física do MVP e não são releases de produção.

## 1. Instalação limpa

1. Desinstale dos dois celulares os aplicativos OGP instalados anteriormente. Eles eram development clients e exibiam as telas `Local server`, `Connect`, `Fetch development servers`, `Updates` e `Scan QR code`.
2. Baixe os dois artifacts standalone da execução indicada no [relatório da Sprint 7](sprint-7-report.md).
3. Extraia cada arquivo ZIP.
4. Instale o APK de `payer-mobile` no celular do pagador.
5. Instale o APK de `merchant-mobile` no celular do lojista.
6. Aceite a instalação de fonte externa apenas para o aplicativo usado para abrir o APK, se o Android solicitar.

Resultado mínimo ao abrir:

```text
payer-mobile     → Pagar sem internet
merchant-mobile  → Receber offline
```

Se aparecer a tela de development server do Expo, o artifact instalado está errado e o gate falhou.

## 2. Prova de inicialização autônoma

1. Feche completamente os dois aplicativos.
2. Ative o modo avião nos dois aparelhos.
3. Confirme que Wi-Fi e dados móveis estão desligados.
4. Abra novamente os dois aplicativos.

Ambos devem chegar às respectivas telas iniciais sem computador, Metro ou rede.

## 3. Troca QR offline completa

1. No merchant, informe um valor inteiro e toque em `CRIAR CHALLENGE`.
2. No payer, toque em `PAGAR OFFLINE` e escaneie o QR do merchant.
3. Confira os dados e toque em `AUTORIZAR`.
4. No merchant, toque em `RECEBER PROVA` e escaneie todos os frames animados exibidos pelo payer.
5. O merchant só pode aceitar depois de persistir e verificar a evidência completa.
6. Confirme no merchant:

```text
Session verified
Signature valid
Credential integrity
Guarantee present
Pending settlement
```

7. No merchant, toque em `MOSTRAR CONFIRMAÇÃO`.
8. No payer, toque em `ESCANEAR CONFIRMAÇÃO` e escaneie o QR de retorno.
9. Confirme no payer a mensagem `Merchant armazenou a prova`.

## 4. Persistência e reinício

Ainda em modo avião:

1. encerre e reabra o payer enquanto houver uma prova ainda não confirmada; ele deve restaurar a ponta da branch e a entrega pendente;
2. encerre e reabra o merchant depois de criar o challenge; ele deve restaurar o challenge pendente;
3. conclua uma aceitação, encerre e reabra o merchant; a evidência aceita não pode desaparecer silenciosamente.

## 5. Registro do resultado

Registre para cada aparelho:

| Campo | Payer | Merchant |
|---|---|---|
| Fabricante/modelo |  |  |
| Versão do Android |  |  |
| Inicializou em modo avião |  |  |
| Câmera leu todos os frames |  |  |
| Reinício restaurou estado |  |  |
| Resultado final |  |  |

A Sprint 7 só recebe `PASS` depois que a troca completa e os testes de reinício passam em dois dispositivos físicos. Até lá, a Sprint 8 permanece bloqueada.
