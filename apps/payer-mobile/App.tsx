import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { createPaymentCredential, credentialHash, validateCredentialProofBundle, type ParentState } from "@ogp/credentials";
import { OgpValidationError, equalBytes, type PaymentCredential } from "@ogp/shared-types";
import { QRTransport, assertChallengeEnvironment, type MerchantChallenge, type TransportReceipt } from "@ogp/transports";
import {
  deviceAuthorization,
  deviceSecretHex,
  hexToBytes,
  initialParent,
  sessionCertificate,
  trustContext,
} from "./src/dev-session";

const transport = new QRTransport();
const DEVICE_KEY_STORAGE = "ogp.session.c3.device-key";
const SESSION_STATE_STORAGE = "ogp.session.c3.local-state";

interface StoredSessionState {
  readonly frames: readonly string[];
  readonly pendingDelivery: boolean;
}

type Screen = "home" | "scan-challenge" | "confirm" | "show-credential" | "scan-receipt" | "complete";

function errorText(error: unknown): string {
  if (error instanceof OgpValidationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Falha inesperada";
}

function FrameCarousel({ frames }: { readonly frames: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (frames.length < 2) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % frames.length), 650);
    return () => clearInterval(timer);
  }, [frames]);
  const frame = frames[index] ?? "";
  return <View style={styles.qrCard}><QRCode value={frame} size={250} ecl="L" quietZone={12} /><Text style={styles.frameText}>Parte {index + 1} de {frames.length}</Text></View>;
}

function Scanner({ title, onCode, onCancel }: { title: string; onCode: (data: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View style={styles.center}><Text>Preparando câmera…</Text></View>;
  if (!permission.granted) return <View style={styles.center}><Text style={styles.body}>A câmera é usada somente para ler o QR offline.</Text><Action label="Permitir câmera" onPress={() => void requestPermission()} /><Action label="Cancelar" secondary onPress={onCancel} /></View>;
  const scanned = ({ data }: BarcodeScanningResult) => onCode(data);
  return <View style={styles.scanner}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned} /><View style={styles.scanOverlay}><Text style={styles.scanTitle}>{title}</Text><Action label="Cancelar" secondary onPress={onCancel} /></View></View>;
}

function Action({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{label}</Text></TouchableOpacity>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [challenge, setChallenge] = useState<MerchantChallenge | null>(null);
  const [credentials, setCredentials] = useState<PaymentCredential[]>([]);
  const [parent, setParent] = useState<ParentState>(initialParent);
  const [outgoingFrames, setOutgoingFrames] = useState<readonly string[]>([]);
  const [lastCredential, setLastCredential] = useState<PaymentCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const receivedFrames = useRef(new Set<string>());

  useEffect(() => {
    void (async () => {
      const existing = await SecureStore.getItemAsync(DEVICE_KEY_STORAGE);
      if (existing === null) {
        await SecureStore.setItemAsync(DEVICE_KEY_STORAGE, deviceSecretHex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      }
      const stored = await AsyncStorage.getItem(SESSION_STATE_STORAGE);
      if (stored !== null) {
        const state = JSON.parse(stored) as StoredSessionState;
        const bundle = transport.receiveCredential(state.frames);
        const finalState = validateCredentialProofBundle(trustContext, bundle);
        const restoredCredentials = [...bundle.credentials];
        const restoredLast = restoredCredentials.at(-1) ?? null;
        setCredentials(restoredCredentials);
        setParent(finalState);
        setLastCredential(restoredLast);
        if (state.pendingDelivery && restoredLast !== null) {
          setOutgoingFrames(state.frames);
          setScreen("show-credential");
        }
      }
      setHydrated(true);
    })().catch((reason: unknown) => { setError(errorText(reason)); setHydrated(true); });
  }, []);

  const startScan = (next: "scan-challenge" | "scan-receipt") => {
    receivedFrames.current.clear();
    setError(null);
    setScreen(next);
  };

  const scanChallenge = (frame: string) => {
    receivedFrames.current.add(frame);
    try {
      const decoded = transport.receiveChallenge(receivedFrames.current);
      assertChallengeEnvironment(decoded, trustContext);
      if (equalBytes(decoded.merchant, sessionCertificate.owner)) throw new OgpValidationError("SELF_MERCHANT_FORBIDDEN", "payer cannot pay itself");
      if (decoded.amount > parent.remaining) throw new OgpValidationError("INVALID_AMOUNT", "amount exceeds offline available");
      setChallenge(decoded);
      setScreen("confirm");
    } catch (reason) {
      if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
    }
  };

  const authorizePayment = async () => {
    if (challenge === null) return;
    try {
      const storedSecret = await SecureStore.getItemAsync(DEVICE_KEY_STORAGE);
      if (storedSecret === null) throw new Error("Chave da sessão indisponível");
      const credential = createPaymentCredential(
        trustContext,
        sessionCertificate,
        parent,
        {
          merchant: challenge.merchant,
          merchantDeviceKey: challenge.merchantDeviceKey,
          amount: challenge.amount,
          merchantChallenge: challenge.challenge,
          // Metadata only. It is never used to order competing branches.
          createdAt: sessionCertificate.issuedAt + BigInt(parent.sequence + 1),
        },
        hexToBytes(storedSecret),
      );
      const nextCredentials = [...credentials, credential];
      const frames = transport.sendCredential({ sessionCertificate, deviceAuthorization, credentials: nextCredentials });
      await AsyncStorage.setItem(SESSION_STATE_STORAGE, JSON.stringify({ frames, pendingDelivery: true } satisfies StoredSessionState));
      setCredentials(nextCredentials);
      setLastCredential(credential);
      setParent({ stateHash: credential.newStateHash, sequence: credential.sequence, remaining: credential.newRemaining });
      setOutgoingFrames(frames);
      setScreen("show-credential");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const scanReceipt = (frame: string) => {
    receivedFrames.current.add(frame);
    void (async () => {
      try {
        const receipt: TransportReceipt = transport.receiveReceipt(receivedFrames.current);
        if (lastCredential === null || !equalBytes(receipt.credentialHash, credentialHash(lastCredential)) || !equalBytes(receipt.merchantChallenge, lastCredential.merchantChallenge)) {
          throw new OgpValidationError("INVALID_RECEIPT", "receipt does not acknowledge the displayed credential");
        }
        await AsyncStorage.setItem(SESSION_STATE_STORAGE, JSON.stringify({ frames: outgoingFrames, pendingDelivery: false } satisfies StoredSessionState));
        setScreen("complete");
      } catch (reason) {
        if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
      }
    })();
  };

  if (screen === "scan-challenge") return <Scanner title="Escaneie o pedido do merchant" onCode={scanChallenge} onCancel={() => setScreen("home")} />;
  if (screen === "scan-receipt") return <Scanner title="Escaneie a confirmação do merchant" onCode={scanReceipt} onCancel={() => setScreen("show-credential")} />;

  return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>OFFLINE GUARANTEE</Text>
    <Text style={styles.title}>{screen === "home" ? "Pagar sem internet" : screen === "confirm" ? "Confirmar pagamento" : screen === "show-credential" ? "Mostre ao merchant" : "Pagamento recebido"}</Text>
    {error !== null && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}

    {screen === "home" && <>
      <View style={styles.balance}><Text style={styles.balanceLabel}>Offline disponível</Text><Text style={styles.balanceValue}>{parent.remaining.toString()}</Text><Text style={styles.balanceUnit}>unidades do token de liquidação</Text></View>
      <View style={styles.row}><View style={styles.stat}><Text style={styles.statLabel}>Collateral</Text><Text style={styles.statValue}>{sessionCertificate.collateralLocked.toString()}</Text></View><View style={styles.stat}><Text style={styles.statLabel}>Sessão</Text><Text style={styles.statValue}>Pronta</Text></View></View>
      <Action label={hydrated ? "PAGAR OFFLINE" : "CARREGANDO ESTADO…"} disabled={!hydrated} onPress={() => startScan("scan-challenge")} />
      <Text style={styles.footnote}>Fixture local da Sprint 7. A ativação on-chain e MWA entram no E2E da Sprint 8.</Text>
      <Text style={styles.history}>{credentials.length} pagamento(s) no histórico local</Text>
    </>}

    {screen === "confirm" && challenge !== null && <>
      <View style={styles.balance}><Text style={styles.balanceLabel}>Valor solicitado</Text><Text style={styles.balanceValue}>{challenge.amount.toString()}</Text></View>
      <View style={styles.check}><Text>✓ Ambiente do protocolo confere</Text><Text>✓ Challenge não reutilizado nesta operação</Text><Text>✓ Saldo offline suficiente</Text></View>
      <Action label="AUTORIZAR" onPress={() => void authorizePayment()} /><Action label="Cancelar" secondary onPress={() => setScreen("home")} />
    </>}

    {screen === "show-credential" && <>
      <Text style={styles.body}>Mantenha esta tela apontada para a câmera do merchant. As partes mudam automaticamente.</Text>
      <FrameCarousel frames={outgoingFrames} />
      <Action label="ESCANEAR CONFIRMAÇÃO" onPress={() => startScan("scan-receipt")} />
    </>}

    {screen === "complete" && <>
      <View style={styles.success}><Text style={styles.successMark}>✓</Text><Text style={styles.successTitle}>Merchant armazenou a prova</Text><Text style={styles.body}>O recibo confirma transporte e armazenamento local. Liquidação ainda está pendente.</Text></View>
      <Action label="CONCLUIR" onPress={() => { setChallenge(null); setLastCredential(null); setOutgoingFrames([]); setScreen("home"); }} />
    </>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f1e8" }, container: { flexGrow: 1, padding: 24, paddingTop: 48 }, center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: "#f4f1e8" },
  eyebrow: { color: "#176b5b", fontSize: 12, fontWeight: "800", letterSpacing: 2 }, title: { color: "#102a25", fontSize: 34, fontWeight: "800", marginTop: 10, marginBottom: 28 }, body: { color: "#40534f", fontSize: 16, lineHeight: 23, textAlign: "center" },
  balance: { backgroundColor: "#102a25", borderRadius: 24, padding: 24, marginBottom: 16 }, balanceLabel: { color: "#a8c9c1", fontSize: 14 }, balanceValue: { color: "#fff", fontSize: 52, fontWeight: "800", marginTop: 4 }, balanceUnit: { color: "#a8c9c1", fontSize: 12 },
  row: { flexDirection: "row", gap: 12, marginBottom: 24 }, stat: { flex: 1, backgroundColor: "#fff", padding: 18, borderRadius: 18 }, statLabel: { color: "#6d7c78", fontSize: 12 }, statValue: { color: "#102a25", fontSize: 20, fontWeight: "700", marginTop: 5 },
  action: { backgroundColor: "#e65c32", borderRadius: 16, padding: 17, alignItems: "center", marginTop: 12 }, actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#a9b4b0" }, actionText: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.5 }, actionTextSecondary: { color: "#29413b" }, disabled: { opacity: 0.45 },
  footnote: { color: "#6d7c78", fontSize: 12, lineHeight: 17, marginTop: 18 }, history: { color: "#176b5b", fontWeight: "700", marginTop: 20 }, check: { backgroundColor: "#fff", borderRadius: 18, padding: 20, gap: 12, marginBottom: 8 },
  qrCard: { backgroundColor: "#fff", borderRadius: 24, padding: 18, alignItems: "center", marginVertical: 24 }, frameText: { color: "#40534f", fontWeight: "700", marginTop: 12 },
  error: { backgroundColor: "#fee7df", borderRadius: 12, padding: 12, marginBottom: 16 }, errorText: { color: "#8b2c12", fontSize: 13 }, success: { backgroundColor: "#fff", borderRadius: 24, padding: 28, alignItems: "center", gap: 12 }, successMark: { color: "#176b5b", fontSize: 52, fontWeight: "900" }, successTitle: { color: "#102a25", fontSize: 22, fontWeight: "800", textAlign: "center" },
  scanner: { flex: 1, backgroundColor: "#000" }, scanOverlay: { flex: 1, justifyContent: "space-between", padding: 28, paddingVertical: 70, backgroundColor: "rgba(0,0,0,0.22)" }, scanTitle: { color: "#fff", fontSize: 24, fontWeight: "800", textAlign: "center" },
});
