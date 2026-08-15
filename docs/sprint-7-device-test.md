# Sprint 7 — teste físico dos APKs standalone

Este roteiro é o gate final da Sprint 7. Ele usa dois APKs de preview com o bundle JavaScript embutido. Nenhum servidor Expo, Metro, QR de desenvolvimento ou computador deve ser necessário para abrir os aplicativos.

> Os APKs são previews assinados com a chave de desenvolvimento gerada no build. Servem apenas para a validação física do MVP e não são releases de produção.

## 1. Instalação limpa

1. Desinstale dos dois celulares os development clients antigos, caso ainda estejam instalados. Eles exibiam as telas `Local server`, `Connect`, `Fetch development servers`, `Updates` e `Scan QR code`.
2. Para o payer, use exclusivamente o artifact `sprint-7-payer-mobile-android-arm64-standalone-preview` da [execução final 31848322396](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31848322396). Os payer anteriores têm um fixture truncado e são obsoletos.
3. Para o merchant, o artifact `android-arm64-standalone-preview` já instalado pode ser mantido; ele não continha o defeito do fixture do payer.
4. Extraia o ZIP do payer e instale seu `app-release.apk` no celular do pagador.
5. Instale o APK de `merchant-mobile` no celular do lojista apenas se ainda não estiver instalado.
6. Aceite a instalação de fonte externa apenas para o aplicativo usado para abrir o APK, se o Android solicitar.

Resultado mínimo ao abrir:

```text
OGP Pagador     → Pagar sem internet
OGP Lojista     → Receber sem internet
```

Se aparecer a tela de development server do Expo, o artifact instalado está errado e o gate falhou.

## 2. Prova de inicialização autônoma

1. Feche completamente os dois aplicativos.
2. Ative o modo avião nos dois aparelhos.
3. Confirme que Wi-Fi e dados móveis estão desligados.
4. Abra novamente os dois aplicativos.

Ambos devem chegar às respectivas telas iniciais sem computador, Metro ou rede.

## 3. Troca QR offline completa

1. No lojista, informe um valor inteiro e toque em `CRIAR PEDIDO`.
2. No pagador, toque em `PAGAR SEM INTERNET` e escaneie o QR do lojista.
3. Confira os dados e toque em `AUTORIZAR`.
4. No lojista, toque em `RECEBER PROVA` e escaneie todos os quadros animados exibidos pelo pagador.
5. O lojista só pode aceitar depois de persistir e verificar a evidência completa.
6. Confirme no lojista:

```text
Sessão verificada
Assinatura válida
Credencial íntegra
Garantia presente
Liquidação pendente
```

7. No lojista, toque em `MOSTRAR CONFIRMAÇÃO`.
8. No pagador, toque em `ESCANEAR CONFIRMAÇÃO` e escaneie o QR de retorno.
9. Confirme no pagador a mensagem `O lojista armazenou a prova`.

## 4. Persistência e reinício

Ainda em modo avião:

1. encerre e reabra o pagador enquanto houver uma prova ainda não confirmada; ele deve restaurar a ponta da branch e a entrega pendente;
2. encerre e reabra o lojista depois de criar o pedido; ele deve restaurar o pedido pendente;
3. conclua uma aceitação, encerre e reabra o lojista; a evidência aceita não pode desaparecer silenciosamente;
4. abra o cartão de provas armazenadas e confirme que cada prova possui detalhes próprios;
5. se houver duas provas com mesma sessão, mesmo estado anterior e mesma sequência, mas estados resultantes distintos, a interface pode mostrar apenas `Possível conflito local`. A confirmação protocolar depende da reconciliação on-chain.

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
