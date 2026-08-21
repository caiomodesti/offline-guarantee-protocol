import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import cuesData from "../data/cues.json";

const C = {
  bg: "#080D1A",
  elevated: "#11192B",
  panel: "#151F34",
  blue: "#6E91F2",
  blueSoft: "#A7BDF6",
  white: "#F2F5FA",
  muted: "#9BA9C2",
  green: "#4ADE80",
  violet: "#A579E8",
  amber: "#F6C85F",
  red: "#F47A6A",
  ink: "#102A25",
  payerBg: "#F4F1E8",
  payerGreen: "#176B5B",
  payerOrange: "#E65C32",
  merchantBlue: "#315DFF",
};

const FONT = "Inter, Geist, Segoe UI, Arial, sans-serif";
const MONO = "Cascadia Mono, Geist Mono, Consolas, monospace";
const fps = 30;

type Cue = {id: string; from: number; to: number; text: string};
const cues = cuesData as Cue[];

const clamp = (frame: number, input: number[], output: number[]) =>
  interpolate(frame, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const fadeWindow = (frame: number, duration: number, edge = 18) =>
  Math.min(clamp(frame, [0, edge], [0, 1]), clamp(frame, [duration - edge, duration], [1, 0]));

const Backdrop: React.FC<{accent?: "blue" | "violet" | "green"}> = ({accent = "blue"}) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 22;
  const color = accent === "blue" ? "110,145,242" : accent === "violet" ? "165,121,232" : "74,222,128";
  return (
    <AbsoluteFill style={{background: `linear-gradient(135deg, ${C.bg} 0%, #0D1425 100%)`, overflow: "hidden"}}>
      <div style={{position: "absolute", width: 760, height: 760, borderRadius: "50%", left: -260 + drift, top: -340, background: `radial-gradient(circle, rgba(${color},0.22), rgba(${color},0) 68%)`}} />
      <div style={{position: "absolute", width: 900, height: 900, borderRadius: "50%", right: -420 - drift, bottom: -500, background: "radial-gradient(circle, rgba(165,121,232,0.16), rgba(165,121,232,0) 70%)"}} />
      <div style={{position: "absolute", inset: 0, opacity: 0.17, backgroundImage: "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)", backgroundSize: "64px 64px", transform: `translate(${frame % 64}px, ${frame % 64}px)`}} />
    </AbsoluteFill>
  );
};

const Brand: React.FC<{dark?: boolean}> = ({dark = true}) => (
  <div style={{display: "flex", alignItems: "center", gap: 14, color: dark ? C.white : C.ink}}>
    <div style={{width: 34, height: 34, borderRadius: 10, border: `2px solid ${C.blue}`, display: "grid", placeItems: "center", boxShadow: "0 0 24px rgba(110,145,242,.35)"}}>
      <div style={{width: 12, height: 12, borderRadius: 4, background: `linear-gradient(135deg, ${C.blue}, ${C.violet})`}} />
    </div>
    <span style={{fontFamily: FONT, fontWeight: 800, fontSize: 22, letterSpacing: 4}}>OFFLINE GUARANTEE</span>
  </div>
);

const SceneFrame: React.FC<{children: React.ReactNode; accent?: "blue" | "violet" | "green"; label?: string}> = ({children, accent, label}) => (
  <AbsoluteFill style={{fontFamily: FONT, color: C.white}}>
    <Backdrop accent={accent} />
    <div style={{position: "absolute", left: 72, top: 52}}><Brand /></div>
    {label ? <div style={{position: "absolute", right: 72, top: 58, fontSize: 18, color: C.muted, letterSpacing: 1.6, textTransform: "uppercase"}}>{label}</div> : null}
    {children}
  </AbsoluteFill>
);

const CaptionLayer: React.FC = () => {
  const frame = useCurrentFrame();
  const cue = cues.find((item) => frame >= item.from && frame < item.to);
  if (!cue) return null;
  const local = frame - cue.from;
  const opacity = Math.min(clamp(local, [0, 8], [0, 1]), clamp(frame, [cue.to - 8, cue.to], [1, 0]));
  return (
    <div style={{position: "absolute", left: 270, right: 270, bottom: 40, display: "flex", justifyContent: "center", zIndex: 100, opacity}}>
      <div style={{maxWidth: 1260, background: "rgba(5,9,18,.84)", color: C.white, border: "1px solid rgba(167,189,246,.25)", borderRadius: 14, padding: "13px 22px", fontFamily: FONT, fontSize: 30, fontWeight: 650, lineHeight: 1.25, textAlign: "center", boxShadow: "0 16px 50px rgba(0,0,0,.32)"}}>{cue.text}</div>
    </div>
  );
};

const AudioStack: React.FC = () => (
  <>
    <Audio
      src={staticFile("audio/ogp-ambient-original.wav")}
      volume={(frame) => {
        const fadeIn = clamp(frame, [0, 60], [0, 0.12]);
        const fadeOut = clamp(frame, [3520, 3600], [0.12, 0]);
        return Math.min(fadeIn, fadeOut);
      }}
    />
    {cues.map((cue) => (
      <Sequence key={cue.id} from={cue.from} premountFor={fps}>
        <Audio src={staticFile(`audio/voice/cue-${cue.id}.mp3`)} volume={0.98} />
      </Sequence>
    ))}
  </>
);

const Chip: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = C.blue}) => (
  <div style={{display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 15px", borderRadius: 999, color, background: `${color}16`, border: `1px solid ${color}55`, fontSize: 19, fontWeight: 800, letterSpacing: .4}}>{children}</div>
);

const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps: sceneFps} = useVideoConfig();
  const s = spring({frame, fps: sceneFps, config: {damping: 18, stiffness: 85, mass: 1.2}});
  const line = clamp(frame, [30, 80], [0, 1]);
  const noSignal = clamp(frame, [110, 155], [0, 1]);
  return (
    <SceneFrame label="Visão geral do protocolo">
      <div style={{position: "absolute", left: 150, right: 150, top: 215, textAlign: "center", opacity: fadeWindow(frame, 240)}}>
        <div style={{fontSize: 92, fontWeight: 760, letterSpacing: -4, lineHeight: 1.02, transform: `scale(${0.92 + s * .08})`}}>E se a internet cair</div>
        <div style={{fontSize: 92, fontWeight: 760, letterSpacing: -4, color: C.blueSoft, marginTop: 8, opacity: line, transform: `translateY(${28 * (1 - line)}px)`}}>na hora de pagar?</div>
        <div style={{marginTop: 62, display: "flex", alignItems: "center", justifyContent: "center", gap: 18, opacity: noSignal}}>
          {[34, 26, 18, 10].map((h, i) => <div key={h} style={{width: 16, height: h, borderRadius: 5, background: i < 2 ? C.red : "#46516A"}} />)}
          <div style={{width: 2, height: 64, background: C.red, transform: "rotate(42deg)", marginLeft: -64}} />
          <span style={{marginLeft: 18, fontFamily: MONO, fontSize: 22, color: C.red}}>SEM CONEXÃO</span>
        </div>
      </div>
    </SceneFrame>
  );
};

const ProblemScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cards = [
    {title: "Saldo reutilizado?", body: "O lojista não enxerga outros pagamentos offline.", color: C.red},
    {title: "Qual veio primeiro?", body: "Horários do aparelho não provam ordem absoluta.", color: C.amber},
    {title: "Quem assume o risco?", body: "A responsabilidade precisa ter um teto explícito.", color: C.violet},
  ];
  return (
    <SceneFrame accent="violet" label="O problema real">
      <div style={{position: "absolute", left: 125, right: 125, top: 170, opacity: fadeWindow(frame, 390)}}>
        <div style={{fontSize: 62, fontWeight: 760, letterSpacing: -2}}>Offline muda a pergunta.</div>
        <div style={{fontSize: 32, color: C.muted, marginTop: 16}}>Não é “como impedir todo conflito?”, mas “como provar e limitar o risco?”.</div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 26, marginTop: 74}}>
          {cards.map((card, index) => {
            const p = clamp(frame, [40 + index * 24, 80 + index * 24], [0, 1]);
            return <div key={card.title} style={{minHeight: 300, padding: 32, borderRadius: 26, background: "rgba(17,25,43,.86)", border: `1px solid ${card.color}55`, transform: `translateY(${45 * (1 - p)}px)`, opacity: p, boxShadow: "0 24px 80px rgba(0,0,0,.26)"}}>
              <div style={{width: 46, height: 6, borderRadius: 9, background: card.color, marginBottom: 34}} />
              <div style={{fontSize: 31, fontWeight: 760}}>{card.title}</div>
              <div style={{fontSize: 24, color: C.muted, lineHeight: 1.45, marginTop: 18}}>{card.body}</div>
            </div>;
          })}
        </div>
      </div>
    </SceneFrame>
  );
};

const MetricCard: React.FC<{label: string; value: string; note: string; color: string; progress: number}> = ({label, value, note, color, progress}) => (
  <div style={{padding: 30, borderRadius: 24, background: "rgba(17,25,43,.92)", border: `1px solid ${color}55`, opacity: progress, transform: `translateY(${36 * (1 - progress)}px)`}}>
    <div style={{fontFamily: MONO, color, fontSize: 18, fontWeight: 800}}>{label}</div>
    <div style={{fontFamily: MONO, fontSize: 54, fontWeight: 850, marginTop: 18}}>{value}</div>
    <div style={{fontSize: 20, color: C.muted, marginTop: 14, lineHeight: 1.4}}>{note}</div>
  </div>
);

const EconomicsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const p1 = clamp(frame, [30, 72], [0, 1]);
  const p2 = clamp(frame, [65, 107], [0, 1]);
  const p3 = clamp(frame, [100, 142], [0, 1]);
  const lock = clamp(frame, [180, 260], [0, 1]);
  return (
    <SceneFrame accent="blue" label="Sessão e garantia">
      <div style={{position: "absolute", left: 110, right: 110, top: 145, opacity: fadeWindow(frame, 570)}}>
        <div style={{display: "flex", alignItems: "flex-end", justifyContent: "space-between"}}>
          <div><div style={{fontSize: 59, fontWeight: 760}}>Três limites. Três funções.</div><div style={{fontSize: 26, color: C.muted, marginTop: 12}}>O protocolo não trata “limite offline” como um único número.</div></div>
          <Chip color={C.amber}>EXEMPLO EM UNIDADES DE TESTE</Chip>
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 22, marginTop: 54}}>
          <MetricCard label="BRANCH SPENDING LIMIT" value="1.000" note="Máximo acumulado em um único caminho válido." color={C.blue} progress={p1} />
          <MetricCard label="AGGREGATE EXPOSURE" value="até forks" note="Pode superar o limite de um branch quando existem conflitos." color={C.violet} progress={p2} />
          <MetricCard label="COVERAGE CAP" value="3.000" note="Teto máximo da responsabilidade econômica da sessão." color={C.green} progress={p3} />
        </div>
        <div style={{marginTop: 34, padding: "24px 30px", borderRadius: 22, background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.32)", display: "flex", alignItems: "center", justifyContent: "space-between", opacity: lock}}>
          <div><div style={{fontSize: 18, color: C.green, fontWeight: 850, letterSpacing: 1}}>REGRA DO MVP</div><div style={{fontSize: 27, marginTop: 8}}>Pagamento total ≤ colateral reservado</div></div>
          <div style={{fontFamily: MONO, fontSize: 28, color: C.green}}>min(exposição, 3.000)</div>
        </div>
      </div>
    </SceneFrame>
  );
};

const QR: React.FC<{size?: number; dark?: string}> = ({size = 210, dark = "#111"}) => {
  const cells = 21;
  const unit = size / cells;
  const bits = Array.from({length: cells * cells}, (_, index) => {
    const x = index % cells;
    const y = Math.floor(index / cells);
    const finder = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7 && (x === ox || y === oy || x === ox + 6 || y === oy + 6 || (x >= ox + 2 && x <= ox + 4 && y >= oy + 2 && y <= oy + 4));
    return finder(0, 0) || finder(14, 0) || finder(0, 14) || ((x * 17 + y * 31 + x * y * 7) % 11 < 5 && !((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)));
  });
  return <div style={{width: size, height: size, background: "white", padding: unit, display: "grid", gridTemplateColumns: `repeat(${cells}, ${unit}px)`, gridTemplateRows: `repeat(${cells}, ${unit}px)`, boxSizing: "content-box"}}>{bits.map((bit, i) => <div key={i} style={{background: bit ? dark : "white"}} />)}</div>;
};

const Phone: React.FC<{children: React.ReactNode; x: number; y: number; scale?: number; tilt?: number; accent: string; label: string}> = ({children, x, y, scale = 1, tilt = 0, accent, label}) => (
  <div style={{position: "absolute", left: x, top: y, width: 360, height: 720, borderRadius: 48, padding: 12, background: "linear-gradient(145deg,#273044,#070A10)", boxShadow: "0 38px 100px rgba(0,0,0,.45)", transform: `scale(${scale}) rotate(${tilt}deg)`, transformOrigin: "top left"}}>
    <div style={{position: "absolute", width: 110, height: 24, borderRadius: 18, background: "#05070B", top: 16, left: 125, zIndex: 5}} />
    <div style={{width: "100%", height: "100%", borderRadius: 37, overflow: "hidden", background: "white"}}>{children}</div>
    <div style={{position: "absolute", right: -2, top: 120, width: 4, height: 92, borderRadius: 6, background: accent}} />
    <div style={{position: "absolute", left: 35, bottom: -46, fontFamily: FONT, fontSize: 18, color: C.muted, width: 290, textAlign: "center"}}>{label}</div>
  </div>
);

const PayerHome: React.FC<{amount?: number}> = ({amount = 1000}) => (
  <div style={{height: "100%", background: C.payerBg, padding: "56px 24px 24px", boxSizing: "border-box", color: C.ink, fontFamily: FONT}}>
    <div style={{fontSize: 11, fontWeight: 900, letterSpacing: 2.8, color: C.payerGreen}}>OFFLINE GUARANTEE</div>
    <div style={{fontSize: 34, fontWeight: 850, marginTop: 18}}>Pagar sem internet</div>
    <div style={{background: C.ink, color: "white", borderRadius: 24, padding: 24, marginTop: 28}}>
      <div style={{fontSize: 15, color: "#A8C9C1"}}>Offline disponível</div>
      <div style={{fontSize: 64, fontWeight: 850, marginTop: 4}}>{amount}</div>
      <div style={{fontSize: 12, color: "#A8C9C1"}}>unidades do token de liquidação</div>
    </div>
    <div style={{display: "flex", gap: 12, marginTop: 16}}>
      <div style={{flex: 1, padding: 18, borderRadius: 18, background: "white"}}><div style={{color: "#6D7C78", fontSize: 12}}>Colateral</div><div style={{fontSize: 22, fontWeight: 800, marginTop: 6}}>3000</div></div>
      <div style={{flex: 1, padding: 18, borderRadius: 18, background: "white"}}><div style={{color: "#6D7C78", fontSize: 12}}>Sessão</div><div style={{fontSize: 22, fontWeight: 800, marginTop: 6}}>Pronta</div></div>
    </div>
    <div style={{marginTop: 24, background: C.payerOrange, borderRadius: 16, color: "white", textAlign: "center", padding: 18, fontWeight: 900}}>PAGAR OFFLINE</div>
    <div style={{fontSize: 12, color: "#6D7C78", marginTop: 22, lineHeight: 1.5}}>Sessão de demonstração. Valores em unidades de teste.</div>
  </div>
);

const PayerConfirm: React.FC = () => (
  <div style={{height: "100%", background: C.payerBg, padding: "56px 24px 24px", boxSizing: "border-box", color: C.ink, fontFamily: FONT}}>
    <div style={{fontSize: 11, fontWeight: 900, letterSpacing: 2.8, color: C.payerGreen}}>OFFLINE GUARANTEE</div>
    <div style={{fontSize: 32, fontWeight: 850, marginTop: 18}}>Confirmar pagamento</div>
    <div style={{background: C.ink, color: "white", borderRadius: 24, padding: 24, marginTop: 28}}><div style={{color: "#A8C9C1"}}>Valor solicitado</div><div style={{fontSize: 64, fontWeight: 850, marginTop: 8}}>50</div></div>
    <div style={{background: "white", borderRadius: 20, padding: 20, marginTop: 18, fontSize: 16, lineHeight: 2.2}}><div>✓ Ambiente confere</div><div>✓ Challenge não reutilizado</div><div>✓ Saldo offline suficiente</div></div>
    <div style={{marginTop: 20, background: C.payerOrange, borderRadius: 16, color: "white", textAlign: "center", padding: 18, fontWeight: 900}}>AUTORIZAR</div>
  </div>
);

const MerchantRequest: React.FC = () => (
  <div style={{height: "100%", background: "#EFF3F0", padding: "56px 24px 24px", boxSizing: "border-box", color: "#111B32", fontFamily: FONT}}>
    <div style={{fontSize: 11, fontWeight: 900, letterSpacing: 2.8, color: C.merchantBlue}}>OFFLINE GUARANTEE</div>
    <div style={{fontSize: 34, fontWeight: 850, marginTop: 18}}>Mostre ao pagador</div>
    <div style={{fontSize: 15, textAlign: "center", color: "#4D5870", lineHeight: 1.45, marginTop: 18}}>O pagador escaneia este pedido.</div>
    <div style={{display: "flex", justifyContent: "center", marginTop: 28}}><QR size={205} /></div>
    <div style={{textAlign: "center", color: "#4D5870", fontWeight: 800, marginTop: 20}}>Parte 1 de 1</div>
    <div style={{marginTop: 28, background: C.merchantBlue, borderRadius: 16, color: "white", textAlign: "center", padding: 18, fontWeight: 900}}>RECEBER PROVA</div>
  </div>
);

const MerchantVerified: React.FC = () => (
  <div style={{height: "100%", background: "#EFF3F0", padding: "56px 24px 24px", boxSizing: "border-box", color: "#111B32", fontFamily: FONT}}>
    <div style={{fontSize: 11, fontWeight: 900, letterSpacing: 2.8, color: C.merchantBlue}}>OFFLINE GUARANTEE</div>
    <div style={{fontSize: 34, fontWeight: 850, marginTop: 18}}>Pagamento validado</div>
    <div style={{background: "#111B32", borderRadius: 24, padding: 25, marginTop: 28, color: "white"}}>
      <div style={{fontSize: 56, fontWeight: 900}}>50</div>
      {["Session verified", "Signature valid", "Credential integrity", "Guarantee present"].map((line) => <div key={line} style={{fontSize: 16, fontWeight: 750, marginTop: 18}}>✓ {line}</div>)}
      <div style={{display: "inline-block", background: "#FFE18A", color: "#5C4500", borderRadius: 999, padding: "8px 12px", marginTop: 18, fontSize: 12, fontWeight: 900}}>LIQUIDAÇÃO PENDENTE</div>
    </div>
    <div style={{fontSize: 13, color: "#6D7688", textAlign: "center", marginTop: 20, lineHeight: 1.45}}>A prova foi persistida antes desta confirmação.</div>
  </div>
);

const MobileFlowScene: React.FC = () => {
  const frame = useCurrentFrame();
  const phase = frame < 190 ? 0 : frame < 390 ? 1 : 2;
  const enter = clamp(frame, [0, 38], [0, 1]);
  const transfer = clamp(frame, [90, 250], [0, 1]);
  const verify = clamp(frame, [390, 470], [0, 1]);
  return (
    <SceneFrame accent="green" label="Fluxo físico sem rede">
      <div style={{position: "absolute", left: 70, top: 145, fontSize: 52, fontWeight: 760, opacity: fadeWindow(frame, 780)}}>Dois aparelhos. Nenhuma conexão.</div>
      <div style={{opacity: fadeWindow(frame, 780)}}>
        <div style={{opacity: enter, transform: `translateX(${50 * (1 - enter)}px)`}}><Phone x={190} y={245} scale={0.92} tilt={-2} accent={C.merchantBlue} label="LOJISTA">{phase === 2 ? <MerchantVerified /> : <MerchantRequest />}</Phone></div>
        <div style={{opacity: enter, transform: `translateX(${-50 * (1 - enter)}px)`}}><Phone x={1395} y={245} scale={0.92} tilt={2} accent={C.payerOrange} label="PAGADOR">{phase === 0 ? <PayerHome /> : <PayerConfirm />}</Phone></div>
        <div style={{position: "absolute", left: 750, top: 355, width: 420, height: 420, display: "grid", placeItems: "center"}}>
          <div style={{position: "absolute", width: 390, height: 2, background: `linear-gradient(90deg, transparent, ${C.blue}, transparent)`, transform: `rotate(${phase === 2 ? 180 : 0}deg) scaleX(${transfer})`, transformOrigin: "center", boxShadow: `0 0 18px ${C.blue}`}} />
          <div style={{width: 245, height: 245, borderRadius: 36, padding: 18, background: "white", boxShadow: "0 20px 90px rgba(0,0,0,.45)", transform: `scale(${.78 + transfer * .22}) rotate(${(transfer - .5) * 4}deg)`, display: "grid", placeItems: "center"}}><QR size={190} /></div>
          <div style={{position: "absolute", bottom: 5, fontFamily: MONO, color: phase === 2 ? C.green : C.blueSoft, fontSize: 18, letterSpacing: 1.2}}>{phase === 0 ? "DESAFIO" : phase === 1 ? "PROVA ASSINADA" : "PROVA ARMAZENADA"}</div>
          {phase === 2 ? <div style={{position: "absolute", top: 0, color: C.green, fontSize: 54, fontWeight: 900, opacity: verify}}>✓</div> : null}
        </div>
        <div style={{position: "absolute", left: 760, top: 820, display: "flex", gap: 14}}><Chip color={C.red}>WI-FI DESLIGADO</Chip><Chip color={C.red}>DADOS DESLIGADOS</Chip></div>
      </div>
    </SceneFrame>
  );
};

const ClaimHistory: React.FC = () => (
  <div style={{height: "100%", background: "#EFF3F0", padding: "56px 24px 24px", boxSizing: "border-box", color: "#111B32", fontFamily: FONT}}>
    <div style={{fontSize: 11, fontWeight: 900, letterSpacing: 2.8, color: C.merchantBlue}}>OFFLINE GUARANTEE</div>
    <div style={{fontSize: 34, fontWeight: 850, marginTop: 18}}>Histórico de provas</div>
    {[{status:"CONFIRMADA ON-CHAIN", color:"#167763", amount:"50"},{status:"AGUARDANDO ENVIO", color:"#9B5B00", amount:"20"}].map((claim) => <div key={claim.status} style={{background: "white", borderRadius: 20, border: "1px solid #DCE2DF", padding: 18, marginTop: 18}}><div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}><div style={{fontSize: 15, fontWeight: 850}}>Pagamento offline</div><div style={{fontSize: 30, fontWeight: 900}}>{claim.amount}</div></div><div style={{fontSize: 12, fontWeight: 900, color: claim.color, marginTop: 14}}>{claim.status}</div><div style={{fontSize: 11, color: "#6D7688", marginTop: 10}}>Prova local íntegra · claim independente</div></div>)}
    <div style={{background: "#E2F4EE", color: "#12624F", borderRadius: 12, padding: 14, marginTop: 22, fontSize: 13, fontWeight: 800}}>Última sincronização confirmada pela conta Claim.</div>
  </div>
);

const ReconnectScene: React.FC = () => {
  const frame = useCurrentFrame();
  const phone = clamp(frame, [0, 40], [0, 1]);
  const steps = [
    {at: 35, title: "Claim enviado", detail: "Evidência portátil dentro do deadline", color: C.blue},
    {at: 105, title: "Conta verificada", detail: "Estado lido do programa Solana", color: C.green},
    {at: 175, title: "Conjunto congelado", detail: "Arrival order não muda a prioridade", color: C.violet},
    {at: 245, title: "Liquidação", detail: "Resultado determinístico e limitado", color: C.amber},
  ];
  return (
    <SceneFrame accent="blue" label="Reconexão e claim">
      <div style={{position: "absolute", left: 120, top: 160, fontSize: 56, fontWeight: 760, opacity: fadeWindow(frame, 510)}}>Reconectar não apaga o risco.</div>
      <div style={{position: "absolute", left: 120, top: 235, fontSize: 27, color: C.muted}}>Transforma a prova local em estado verificável.</div>
      <div style={{opacity: phone}}><Phone x={205} y={325} scale={0.78} tilt={-1.2} accent={C.merchantBlue} label="HISTÓRICO DO LOJISTA"><ClaimHistory /></Phone></div>
      <div style={{position: "absolute", left: 760, top: 320, width: 960, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22}}>
        {steps.map((step, index) => {
          const p = clamp(frame, [step.at, step.at + 34], [0, 1]);
          return <div key={step.title} style={{minHeight: 170, padding: 26, background: "rgba(17,25,43,.92)", border: `1px solid ${step.color}55`, borderRadius: 22, opacity: p, transform: `translateY(${35 * (1 - p)}px)`}}><div style={{fontFamily: MONO, color: step.color, fontSize: 17}}>0{index + 1}</div><div style={{fontSize: 28, fontWeight: 800, marginTop: 15}}>{step.title}</div><div style={{fontSize: 20, color: C.muted, marginTop: 10, lineHeight: 1.35}}>{step.detail}</div></div>;
        })}
      </div>
    </SceneFrame>
  );
};

const EventRow: React.FC<{name: string; status: string; color: string; progress: number}> = ({name, status, color, progress}) => (
  <div style={{display: "grid", gridTemplateColumns: "44px 1fr auto", alignItems: "center", gap: 16, padding: "18px 20px", borderBottom: "1px solid rgba(255,255,255,.06)", opacity: progress, transform: `translateX(${25 * (1 - progress)}px)`}}>
    <div style={{width: 12, height: 12, borderRadius: "50%", background: color, boxShadow: `0 0 18px ${color}`}} />
    <div><div style={{fontFamily: MONO, fontSize: 18, fontWeight: 760}}>{name}</div><div style={{fontSize: 15, color: C.muted, marginTop: 5}}>{status}</div></div>
    <div style={{fontFamily: MONO, fontSize: 14, color}}>CONFIRMADO</div>
  </div>
);

const MonitorScene: React.FC = () => {
  const frame = useCurrentFrame();
  const fork = clamp(frame, [50, 120], [0, 1]);
  const settle = clamp(frame, [170, 245], [0, 1]);
  const revoke = clamp(frame, [260, 335], [0, 1]);
  return (
    <SceneFrame accent="violet" label="Visualização demonstrativa">
      <div style={{position: "absolute", left: 85, right: 85, top: 130, bottom: 110, borderRadius: 28, overflow: "hidden", background: "rgba(11,17,31,.94)", border: "1px solid rgba(167,189,246,.23)", boxShadow: "0 35px 120px rgba(0,0,0,.42)", opacity: fadeWindow(frame, 570)}}>
        <div style={{height: 84, borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 30px"}}>
          <div><div style={{fontSize: 23, fontWeight: 800}}>Monitor do protocolo</div><div style={{fontSize: 14, color: C.muted, marginTop: 4}}>Reconstrução visual para apresentação</div></div>
          <Chip color={C.amber}>NÃO É O DASHBOARD DA SPRINT 10</Chip>
        </div>
        <div style={{display: "grid", gridTemplateColumns: "1.08fr .92fr", height: "calc(100% - 84px)"}}>
          <div style={{padding: 34, borderRight: "1px solid rgba(255,255,255,.08)"}}>
            <div style={{fontSize: 16, color: C.muted, letterSpacing: 1.2}}>GRAFO DA SESSÃO</div>
            <div style={{position: "relative", height: 520, marginTop: 18}}>
              <div style={{position: "absolute", left: 90, top: 225, width: 115, height: 115, borderRadius: 24, background: C.panel, border: `2px solid ${C.blue}`, display: "grid", placeItems: "center", fontFamily: MONO, fontWeight: 800}}>ROOT</div>
              <div style={{position: "absolute", left: 430, top: 125, width: 150, height: 100, borderRadius: 20, background: "#20182D", border: `2px solid ${C.violet}`, display: "grid", placeItems: "center", fontFamily: MONO, opacity: fork}}>BRANCH A</div>
              <div style={{position: "absolute", left: 430, top: 345, width: 150, height: 100, borderRadius: 20, background: "#20182D", border: `2px solid ${C.violet}`, display: "grid", placeItems: "center", fontFamily: MONO, opacity: fork}}>BRANCH B</div>
              <svg width="100%" height="100%" style={{position: "absolute", inset: 0}}>
                <path d="M205 280 C315 280 325 175 430 175" fill="none" stroke={C.violet} strokeWidth="4" strokeDasharray="8 10" strokeDashoffset={80 * (1 - fork)} opacity={fork}/>
                <path d="M205 280 C315 280 325 395 430 395" fill="none" stroke={C.violet} strokeWidth="4" strokeDasharray="8 10" strokeDashoffset={80 * (1 - fork)} opacity={fork}/>
              </svg>
              <div style={{position: "absolute", right: 35, top: 230, width: 210, padding: 22, borderRadius: 20, background: "rgba(74,222,128,.08)", border: "1px solid rgba(74,222,128,.35)", opacity: settle}}><div style={{fontSize: 14, color: C.green, fontWeight: 900}}>PAYOUT TOTAL</div><div style={{fontFamily: MONO, fontSize: 34, marginTop: 10}}>≤ 3.000</div></div>
            </div>
          </div>
          <div style={{padding: 28}}>
            <div style={{fontSize: 16, color: C.muted, letterSpacing: 1.2, marginBottom: 16}}>EVENTOS AUTORITATIVOS</div>
            <EventRow name="FORK DETECTED" status="Irmãos válidos aceitos on-chain" color={C.violet} progress={fork} />
            <EventRow name="COLLATERAL COVERS CLAIMS" status="Alocação final respeita o cap" color={C.green} progress={settle} />
            <EventRow name="OFFLINE ACCESS REVOKED" status="Revogação na mesma transição" color={C.red} progress={revoke} />
            <div style={{marginTop: 26, padding: 22, borderRadius: 18, background: "rgba(110,145,242,.08)", border: "1px solid rgba(110,145,242,.28)", fontSize: 18, lineHeight: 1.45, color: C.blueSoft}}>A interface só apresenta o que pode ser reconstruído de contas, transações e eventos do protocolo.</div>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
};

const EvidenceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const items = [
    ["SBF + runtime Solana", "PASS", C.green],
    ["CPI real do SPL Token", "PASS", C.green],
    ["Fluxo offline em 2 aparelhos", "PASS", C.green],
    ["Fuzzing reproduzível", "12.240 casos", C.blue],
    ["Sprint 8 E2E", "EM DESENVOLVIMENTO", C.amber],
  ] as const;
  return (
    <SceneFrame accent="green" label="Evidência atual">
      <div style={{position: "absolute", left: 165, right: 165, top: 160, opacity: fadeWindow(frame, 330)}}>
        <div style={{fontSize: 62, fontWeight: 760}}>O que já foi provado.</div>
        <div style={{fontSize: 27, color: C.muted, marginTop: 14}}>Resultados do repositório — sem confundir MVP experimental com produção.</div>
        <div style={{marginTop: 54, borderRadius: 24, overflow: "hidden", background: "rgba(17,25,43,.92)", border: "1px solid rgba(255,255,255,.1)"}}>
          {items.map(([label, status, color], index) => {
            const p = clamp(frame, [35 + index * 28, 68 + index * 28], [0, 1]);
            return <div key={label} style={{display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", padding: "21px 28px", borderBottom: index === items.length - 1 ? "none" : "1px solid rgba(255,255,255,.07)", opacity: p, transform: `translateX(${28 * (1 - p)}px)`}}><div style={{fontSize: 23, fontWeight: 680}}>{label}</div><div style={{fontFamily: MONO, color, fontSize: 18, fontWeight: 850}}>{status}</div></div>;
          })}
        </div>
      </div>
    </SceneFrame>
  );
};

const EndScene: React.FC = () => {
  const frame = useCurrentFrame();
  const p = spring({frame, fps, config: {damping: 22, stiffness: 85}});
  return (
    <SceneFrame accent="blue">
      <div style={{position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", transform: `scale(${.96 + .04 * p})`, opacity: clamp(frame, [0, 25], [0, 1])}}>
        <Brand />
        <div style={{fontSize: 66, fontWeight: 780, marginTop: 58, letterSpacing: -2}}>Risco offline, agora mensurável.</div>
        <div style={{fontSize: 28, color: C.blueSoft, marginTop: 20}}>Detectável · garantido por colateral · determinístico · limitado</div>
        <div style={{marginTop: 52, padding: "18px 28px", borderRadius: 16, background: "rgba(110,145,242,.12)", border: "1px solid rgba(110,145,242,.4)", fontFamily: MONO, fontSize: 24}}>github.com/caiomodesti/offline-guarantee-protocol</div>
        <div style={{fontSize: 17, color: C.muted, maxWidth: 980, lineHeight: 1.5, marginTop: 35}}>Protocolo experimental. Não representa BRL, não integra Pix e ainda não está pronto para produção.</div>
      </div>
    </SceneFrame>
  );
};

export const OGPOverview: React.FC = () => (
  <AbsoluteFill style={{background: C.bg}}>
    <Sequence from={0} durationInFrames={240} premountFor={fps}><HookScene /></Sequence>
    <Sequence from={240} durationInFrames={390} premountFor={fps}><ProblemScene /></Sequence>
    <Sequence from={630} durationInFrames={570} premountFor={fps}><EconomicsScene /></Sequence>
    <Sequence from={1200} durationInFrames={810} premountFor={fps}><MobileFlowScene /></Sequence>
    <Sequence from={2010} durationInFrames={510} premountFor={fps}><ReconnectScene /></Sequence>
    <Sequence from={2520} durationInFrames={540} premountFor={fps}><MonitorScene /></Sequence>
    <Sequence from={3060} durationInFrames={330} premountFor={fps}><EvidenceScene /></Sequence>
    <Sequence from={3390} durationInFrames={210} premountFor={fps}><EndScene /></Sequence>
    <AudioStack />
    <CaptionLayer />
  </AbsoluteFill>
);

export const OGPThumbnail: React.FC = () => (
  <AbsoluteFill style={{fontFamily: FONT, color: C.white}}>
    <Backdrop accent="blue" />
    <div style={{position: "absolute", left: 125, top: 95}}><Brand /></div>
    <div style={{position: "absolute", left: 125, top: 270, width: 980}}>
      <div style={{fontSize: 82, fontWeight: 800, lineHeight: 1.04, letterSpacing: -3}}>Pagamentos offline.<br/><span style={{color: C.blueSoft}}>Risco limitado.</span></div>
      <div style={{fontSize: 30, color: C.muted, marginTop: 30, lineHeight: 1.4}}>Como o OGP transforma provas locais em liquidação determinística na Solana.</div>
      <div style={{marginTop: 44}}><Chip color={C.green}>PROTOCOLO EXPERIMENTAL · DEMO EM PORTUGUÊS</Chip></div>
    </div>
    <Phone x={1370} y={170} scale={1.02} tilt={3} accent={C.payerOrange} label=""><PayerHome amount={950} /></Phone>
  </AbsoluteFill>
);
