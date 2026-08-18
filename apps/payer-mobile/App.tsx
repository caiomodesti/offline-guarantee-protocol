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
import { createPersistedOnchainSession } from "./src/onchain-provisioning";
import { evaluatePayerRecovery, type PayerRecoveryChainPort, type PayerRecoveryStoragePort } from "./src/onchain-recovery-controller";
import { ONCHAIN_BRANCH_STORAGE, ONCHAIN_DEVICE_KEY_STORAGE, ONCHAIN_PROVISIONING_STORAGE } from "./src/payer-storage-keys";
import { createPayerCrashConsistentStorage } from "./src/payer-crash-storage";
import { bytesToHex, hexToBytes, type PayerSessionRuntime } from "./src/payer-runtime";
import { configuredTrustEnvironment } from "./src/runtime-configuration";
import { bootstrapPayerRuntime, type PayerRuntimeMode } from "./src/runtime-mode";

const transport = new QRTransport();
const DEVICE_KEY_STORAGE = "ogp.session.c3.device-key";
const SESSION_STATE_STORAGE = "ogp.session.c3.local-state";

const recoveryStorage: PayerRecoveryStoragePort = createPayerCrashConsistentStorage({
  get: async (area, key) => area === "protected" ? SecureStore.getItemAsync(key) : AsyncStorage.getItem(key),
  set: async (area, key, value) => area === "protected"
    ? SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
    : AsyncStorage.setItem(key, value),
  remove: async (area, key) => area === "protected" ? SecureStore.deleteItemAsync(key) : AsyncStorage.removeItem(key),
}, {
  load: async () => ({
    provisioningJson: await AsyncStorage.getItem(ONCHAIN_PROVISIONING_STORAGE),
    branchStateJson: await AsyncStorage.getItem(ONCHAIN_BRANCH_STORAGE),
    deviceSecretHex: await SecureStore.getItemAsync(ONCHAIN_DEVICE_KEY_STORAGE),
  }),
});

const forbiddenOfflineChainRead: PayerRecoveryChainPort = {
  fetchConfirmedRecovery: async () => { throw new Error("RPC não pode ser consultado durante o bootstrap offline"); },
};

interface StoredSessionState {
  readonly frames: readonly string[];
  readonly pendingDelivery: boolean;
}

type Screen = "home" | "scan-challenge" | "confirm" | "show-credential" | "scan-receipt" | "complete";
type BootstrapStatus = "loading" | "ready" | "online-recovery-required";

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

interface PayerApplicationProps {
  readonly configuredMode: PayerRuntimeMode;
  readonly loadDevelopmentRuntime?: () => PayerSessionRuntime;
}

export function PayerApplication({ configuredMode, loadDevelopmentRuntime }: PayerApplicationProps) {
  const [screen, setScreen] = useState<Screen>("home");
  const [sessionRuntime, setSessionRuntime] = useState<PayerSessionRuntime | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<PayerRuntimeMode | null>(null);
  const [onchainSessionAccount, setOnchainSessionAccount] = useState<Uint8Array | null>(null);
  const [challenge, setChallenge] = useState<MerchantChallenge | null>(null);
  const [credentials, setCredentials] = useState<PaymentCredential[]>([]);
  const [parent, setParent] = useState<ParentState | null>(null);
  const [outgoingFrames, setOutgoingFrames] = useState<readonly string[]>([]);
  const [lastCredential, setLastCredential] = useState<PaymentCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>("loading");
  const receivedFrames = useRef(new Set<string>());

  useEffect(() => {
    void (async () => {
      const mode = configuredMode;
      setRuntimeMode(mode);
      if (mode === "on-chain") {
        const expected = configuredTrustEnvironment({
          EXPO_PUBLIC_OGP_NETWORK_ID: process.env.EXPO_PUBLIC_OGP_NETWORK_ID,
          EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX: process.env.EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX,
          EXPO_PUBLIC_OGP_PROGRAM_ID_HEX: process.env.EXPO_PUBLIC_OGP_PROGRAM_ID_HEX,
          EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX: process.env.EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX,
        });
        const recovery = await evaluatePayerRecovery({ connected: false, walletOwnerHex: null, expectedEnvironment: expected }, recoveryStorage, forbiddenOfflineChainRead);
        if (recovery.decision.outcome !== "offline-ready" || recovery.restoredSession === null) {
          if (recovery.localValidationError !== null) setError(recovery.localValidationError);
          setBootstrapStatus("online-recovery-required");
          return;
        }
        const restored = recovery.restoredSession;
        const restoredLast = restored.credentials.at(-1) ?? null;
        setSessionRuntime(restored.runtime);
        setOnchainSessionAccount(hexToBytes(restored.localProvisioning.sessionAccount));
        setCredentials([...restored.credentials]);
        setParent(restored.parent);
        setLastCredential(restoredLast);
        if (restored.pendingDelivery && restoredLast !== null) {
          setOutgoingFrames(restored.outgoingFrames);
          setScreen("show-credential");
        }
        setBootstrapStatus("ready");
        return;
      }

      const bootstrap = bootstrapPayerRuntime(mode, loadDevelopmentRuntime);
      if (bootstrap.kind !== "ready") throw new Error("fixture de desenvolvimento indisponível");
      const runtime = bootstrap.runtime;
      const existing = await SecureStore.getItemAsync(DEVICE_KEY_STORAGE);
      if (existing === null) {
        await SecureStore.setItemAsync(DEVICE_KEY_STORAGE, runtime.deviceSecretHex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      }
      let restoredParent = runtime.initialParent;
      const stored = await AsyncStorage.getItem(SESSION_STATE_STORAGE);
      if (stored !== null) {
        const state = JSON.parse(stored) as StoredSessionState;
        const bundle = transport.receiveCredential(state.frames);
        const finalState = validateCredentialProofBundle(runtime.trustContext, bundle);
        const restoredCredentials = [...bundle.credentials];
        const restoredLast = restoredCredentials.at(-1) ?? null;
        setCredentials(restoredCredentials);
        restoredParent = finalState;
        setLastCredential(restoredLast);
        if (state.pendingDelivery && restoredLast !== null) {
          setOutgoingFrames(state.frames);
          setScreen("show-credential");
        }
      }
      setSessionRuntime(runtime);
      setParent(restoredParent);
      setBootstrapStatus("ready");
    })().catch((reason: unknown) => { setError(errorText(reason)); setBootstrapStatus("online-recovery-required"); });
  }, [configuredMode, loadDevelopmentRuntime]);

  const persistBranchState = async (frames: readonly string[], pendingDelivery: boolean, nextParent: ParentState) => {
    if (sessionRuntime === null) throw new Error("Sessão de pagamento indisponível");
    if (runtimeMode === "on-chain") {
      if (onchainSessionAccount === null) throw new Error("Conta on-chain da sessão indisponível");
      const persisted = createPersistedOnchainSession({ sessionAccount: onchainSessionAccount, runtime: sessionRuntime, parent: nextParent, frames, pendingDelivery });
      await recoveryStorage.commit(persisted);
      return;
    }
    await AsyncStorage.setItem(SESSION_STATE_STORAGE, JSON.stringify({ frames, pendingDelivery } satisfies StoredSessionState));
  };

  const startScan = (next: "scan-challenge" | "scan-receipt") => {
    receivedFrames.current.clear();
    setError(null);
    setScreen(next);
  };

  const scanChallenge = (frame: string) => {
    receivedFrames.current.add(frame);
    try {
      if (sessionRuntime === null || parent === null) throw new Error("Sessão de pagamento indisponível");
      const decoded = transport.receiveChallenge(receivedFrames.current);
      assertChallengeEnvironment(decoded, sessionRuntime.trustContext);
      if (equalBytes(decoded.merchant, sessionRuntime.sessionCertificate.owner)) throw new OgpValidationError("SELF_MERCHANT_FORBIDDEN", "o pagador não pode pagar a si mesmo");
      if (decoded.amount > parent.remaining) throw new OgpValidationError("INVALID_AMOUNT", "o valor excede o saldo offline disponível");
      setChallenge(decoded);
      setScreen("confirm");
    } catch (reason) {
      if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
    }
  };

  const authorizePayment = async () => {
    if (challenge === null || sessionRuntime === null || parent === null) return;
    try {
      const storedSecret = runtimeMode === "on-chain"
        ? (await recoveryStorage.load()).deviceSecretHex
        : await SecureStore.getItemAsync(DEVICE_KEY_STORAGE);
      if (storedSecret === null) throw new Error("Chave da sessão indisponível");
      const credential = createPaymentCredential(
        sessionRuntime.trustContext,
        sessionRuntime.sessionCertificate,
        parent,
        {
          merchant: challenge.merchant,
          merchantDeviceKey: challenge.merchantDeviceKey,
          amount: challenge.amount,
          merchantChallenge: challenge.challenge,
          // Metadata only. It is never used to order competing branches.
          createdAt: sessionRuntime.sessionCertificate.issuedAt + BigInt(parent.sequence + 1),
        },
        hexToBytes(storedSecret),
      );
      const nextCredentials = [...credentials, credential];
      const frames = transport.sendCredential({ sessionCertificate: sessionRuntime.sessionCertificate, deviceAuthorization: sessionRuntime.deviceAuthorization, credentials: nextCredentials });
      const nextParent = { stateHash: credential.newStateHash, sequence: credential.sequence, remaining: credential.newRemaining };
      await persistBranchState(frames, true, nextParent);
      setCredentials(nextCredentials);
      setLastCredential(credential);
      setParent(nextParent);
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
          throw new OgpValidationError("INVALID_RECEIPT", "a confirmação não corresponde à credencial exibida");
        }
        if (parent === null) throw new Error("Estado da sessão indisponível");
        await persistBranchState(outgoingFrames, false, parent);
        setScreen("complete");
      } catch (reason) {
        if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
      }
    })();
  };

  if (screen === "scan-challenge") return <Scanner title="Escaneie o pedido do lojista" onCode={scanChallenge} onCancel={() => setScreen("home")} />;
  if (screen === "scan-receipt") return <Scanner title="Escaneie a confirmação do lojista" onCode={scanReceipt} onCancel={() => setScreen("show-credential")} />;

  if (bootstrapStatus === "loading") return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.title}>Preparando o pagador…</Text><Text style={styles.body}>Validando a sessão local protegida.</Text></View></SafeAreaView>;
  if (bootstrapStatus === "online-recovery-required") return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><View style={styles.center}><Text style={styles.eyebrow}>GARANTIA OFFLINE</Text><Text style={styles.title}>Conexão necessária</Text><Text style={styles.body}>Esta instalação não possui uma sessão offline completa e confirmada. Conecte-se para recuperar o estado on-chain e autorizar a carteira. Limpar os dados ou reinstalar nunca cria um novo saldo offline.</Text>{error !== null && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}<Text style={styles.footnote}>Nenhum pagamento, chave de sessão ou limite foi recriado automaticamente.</Text></View></SafeAreaView>;
  if (sessionRuntime === null || parent === null) return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.title}>Falha ao iniciar o pagador</Text><Text style={styles.body}>{error ?? "Sessão inicial indisponível"}</Text></View></SafeAreaView>;

  return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>GARANTIA OFFLINE</Text>
    <Text style={styles.title}>{screen === "home" ? "Pagar sem internet" : screen === "confirm" ? "Confirmar pagamento" : screen === "show-credential" ? "Mostre ao lojista" : "Pagamento recebido"}</Text>
    {error !== null && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}

    {screen === "home" && <>
      <View style={styles.balance}><Text style={styles.balanceLabel}>Disponível sem internet</Text><Text style={styles.balanceValue}>{parent.remaining.toString()}</Text><Text style={styles.balanceUnit}>unidades do token de liquidação</Text></View>
      <View style={styles.row}><View style={styles.stat}><Text style={styles.statLabel}>Garantia depositada</Text><Text style={styles.statValue}>{sessionRuntime.sessionCertificate.collateralLocked.toString()}</Text></View><View style={styles.stat}><Text style={styles.statLabel}>Sessão</Text><Text style={styles.statValue}>Pronta</Text></View></View>
      <Action label="PAGAR SEM INTERNET" onPress={() => startScan("scan-challenge")} />
      <Text style={styles.footnote}>{runtimeMode === "on-chain" ? `Sessão recuperada de material assinado e confirmado. ID ${bytesToHex(sessionRuntime.sessionCertificate.sessionId).slice(0, 8)}…` : "Modo explícito de demonstração da Sprint 7. O modo normal da Sprint 8 nunca recria esta fixture após perda de dados."}</Text>
      <Text style={styles.history}>{credentials.length} pagamento(s) no histórico local</Text>
    </>}

    {screen === "confirm" && challenge !== null && <>
      <View style={styles.balance}><Text style={styles.balanceLabel}>Valor solicitado</Text><Text style={styles.balanceValue}>{challenge.amount.toString()}</Text></View>
      <View style={styles.check}><Text>✓ Ambiente do protocolo confere</Text><Text>✓ Pedido único nesta operação</Text><Text>✓ Saldo offline suficiente</Text></View>
      <Action label="AUTORIZAR" onPress={() => void authorizePayment()} /><Action label="Cancelar" secondary onPress={() => setScreen("home")} />
    </>}

    {screen === "show-credential" && <>
      <Text style={styles.body}>Mantenha esta tela apontada para a câmera do lojista. As partes mudam automaticamente.</Text>
      <FrameCarousel frames={outgoingFrames} />
      <Action label="ESCANEAR CONFIRMAÇÃO" onPress={() => startScan("scan-receipt")} />
    </>}

    {screen === "complete" && <>
      <View style={styles.success}><Text style={styles.successMark}>✓</Text><Text style={styles.successTitle}>O lojista armazenou a prova</Text><Text style={styles.body}>O recibo confirma transporte e armazenamento local. A liquidação ainda está pendente.</Text></View>
      <Action label="CONCLUIR" onPress={() => { setChallenge(null); setLastCredential(null); setOutgoingFrames([]); setScreen("home"); }} />
    </>}
  </ScrollView></SafeAreaView>;
}

/** Production entrypoint: environment variables cannot opt this bundle into fixtures. */
export default function App() {
  return <PayerApplication configuredMode="on-chain" />;
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
