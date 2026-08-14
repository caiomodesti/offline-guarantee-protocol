import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { credentialHash } from "@ogp/credentials";
import { derivePublicKey, generateChallenge, generateSecretKey } from "@ogp/crypto";
import { OgpValidationError, type PaymentCredential } from "@ogp/shared-types";
import { QRTransport, validateMerchantResponse, type MerchantChallenge } from "@ogp/transports";
import { bytesToHex, expectedEnvironment, hexToBytes } from "./src/trust";

const transport = new QRTransport();
const DEVICE_KEY_STORAGE = "ogp.merchant.device-key";
const CLAIMS_STORAGE = "ogp.merchant.pending-claims";
const OUTSTANDING_STORAGE = "ogp.merchant.outstanding-challenge";
const merchantWallet = new Uint8Array(32).fill(0x71); // Public development identity only; no wallet secret exists in this app.

type Screen = "home" | "show-challenge" | "scan-credential" | "verified" | "show-receipt";

interface StoredClaim {
  readonly credentialHash: string;
  readonly amount: string;
  readonly sessionId: string;
  readonly frames: readonly string[];
  readonly status: "pending-settlement";
}

interface StoredOutstandingChallenge {
  readonly amount: string;
  readonly challenge: string;
  readonly merchantDeviceKey: string;
}

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
  return <View style={styles.qrCard}><QRCode value={frames[index] ?? ""} size={250} ecl="L" quietZone={12} /><Text style={styles.frameText}>Parte {index + 1} de {frames.length}</Text></View>;
}

function Action({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{label}</Text></TouchableOpacity>;
}

function Scanner({ onCode, onCancel }: { onCode: (data: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View style={styles.center}><Text>Preparando câmera…</Text></View>;
  if (!permission.granted) return <View style={styles.center}><Text style={styles.body}>A câmera lê a prova portátil diretamente do payer.</Text><Action label="Permitir câmera" onPress={() => void requestPermission()} /><Action label="Cancelar" secondary onPress={onCancel} /></View>;
  const scanned = ({ data }: BarcodeScanningResult) => onCode(data);
  return <View style={styles.scanner}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned} /><View style={styles.scanOverlay}><Text style={styles.scanTitle}>Leia todas as partes do payer</Text><Action label="Cancelar" secondary onPress={onCancel} /></View></View>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [amountText, setAmountText] = useState("100");
  const [merchantDeviceKey, setMerchantDeviceKey] = useState<Uint8Array | null>(null);
  const [challenge, setChallenge] = useState<MerchantChallenge | null>(null);
  const [challengeFrames, setChallengeFrames] = useState<readonly string[]>([]);
  const [receiptFrames, setReceiptFrames] = useState<readonly string[]>([]);
  const [verifiedCredential, setVerifiedCredential] = useState<PaymentCredential | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const receivedFrames = useRef(new Set<string>());

  useEffect(() => {
    void (async () => {
      let secretHex = await SecureStore.getItemAsync(DEVICE_KEY_STORAGE);
      if (secretHex === null) {
        secretHex = bytesToHex(generateSecretKey());
        await SecureStore.setItemAsync(DEVICE_KEY_STORAGE, secretHex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      }
      const devicePublicKey = derivePublicKey(hexToBytes(secretHex));
      setMerchantDeviceKey(devicePublicKey);
      const stored = await AsyncStorage.getItem(CLAIMS_STORAGE);
      setPendingCount(stored === null ? 0 : (JSON.parse(stored) as StoredClaim[]).length);
      const outstandingJson = await AsyncStorage.getItem(OUTSTANDING_STORAGE);
      if (outstandingJson !== null) {
        const outstanding = JSON.parse(outstandingJson) as StoredOutstandingChallenge;
        if (!equalBytesForStorage(devicePublicKey, hexToBytes(outstanding.merchantDeviceKey))) throw new Error("Challenge persistido pertence a outro dispositivo");
        const restored: MerchantChallenge = {
          networkId: expectedEnvironment.networkId,
          clusterGenesisHash: expectedEnvironment.clusterGenesisHash,
          programId: expectedEnvironment.programId,
          merchant: merchantWallet,
          merchantDeviceKey: devicePublicKey,
          amount: BigInt(outstanding.amount),
          challenge: hexToBytes(outstanding.challenge),
        };
        setChallenge(restored);
        setChallengeFrames(transport.sendChallenge(restored));
        setScreen("show-challenge");
      }
    })().catch((reason: unknown) => setError(errorText(reason)));
  }, []);

  const createRequest = async () => {
    try {
      if (merchantDeviceKey === null) throw new Error("Identidade do dispositivo ainda não está pronta");
      if (!/^[1-9][0-9]*$/.test(amountText)) throw new OgpValidationError("INVALID_AMOUNT", "use um valor inteiro positivo");
      const amount = BigInt(amountText);
      const request: MerchantChallenge = {
        networkId: expectedEnvironment.networkId,
        clusterGenesisHash: expectedEnvironment.clusterGenesisHash,
        programId: expectedEnvironment.programId,
        merchant: merchantWallet,
        merchantDeviceKey,
        amount,
        challenge: generateChallenge(),
      };
      await AsyncStorage.setItem(OUTSTANDING_STORAGE, JSON.stringify({ amount: amount.toString(), challenge: bytesToHex(request.challenge), merchantDeviceKey: bytesToHex(merchantDeviceKey) }));
      setChallenge(request);
      setChallengeFrames(transport.sendChallenge(request));
      setError(null);
      setScreen("show-challenge");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const beginCredentialScan = () => {
    receivedFrames.current.clear();
    setError(null);
    setScreen("scan-credential");
  };

  const scanCredential = (frame: string) => {
    receivedFrames.current.add(frame);
    void (async () => {
      try {
        if (challenge === null || merchantDeviceKey === null) throw new Error("Nenhum challenge ativo");
        const bundle = transport.receiveCredential(receivedFrames.current);
        const { credential } = validateMerchantResponse(expectedEnvironment, challenge, bundle);

        const hash = credentialHash(credential);
        const stored = await AsyncStorage.getItem(CLAIMS_STORAGE);
        const claims = stored === null ? [] : JSON.parse(stored) as StoredClaim[];
        const hashHex = bytesToHex(hash);
        if (!claims.some((claim) => claim.credentialHash === hashHex)) {
          claims.push({ credentialHash: hashHex, amount: credential.amount.toString(), sessionId: bytesToHex(credential.sessionId), frames: [...receivedFrames.current], status: "pending-settlement" });
          await AsyncStorage.setItem(CLAIMS_STORAGE, JSON.stringify(claims));
        }
        await AsyncStorage.removeItem(OUTSTANDING_STORAGE);
        setPendingCount(claims.length);
        setVerifiedCredential(credential);
        setReceiptFrames(transport.sendReceipt({ credentialHash: hash, merchantChallenge: credential.merchantChallenge }));
        setScreen("verified");
      } catch (reason) {
        if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
      }
    })();
  };

  if (screen === "scan-credential") return <Scanner onCode={scanCredential} onCancel={() => setScreen("show-challenge")} />;

  return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>OFFLINE GUARANTEE</Text>
    <Text style={styles.title}>{screen === "home" ? "Receber offline" : screen === "show-challenge" ? "Mostre ao payer" : screen === "verified" ? "Pagamento validado" : "Confirmação"}</Text>
    {error !== null && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}

    {screen === "home" && <>
      <Text style={styles.label}>Valor</Text><TextInput value={amountText} onChangeText={setAmountText} keyboardType="number-pad" style={styles.input} accessibilityLabel="Valor do pagamento" />
      <Action label="CRIAR CHALLENGE" disabled={merchantDeviceKey === null} onPress={() => void createRequest()} />
      <View style={styles.pending}><Text style={styles.pendingValue}>{pendingCount}</Text><Text style={styles.pendingLabel}>claim(s) armazenado(s) · pending settlement</Text></View>
      <Text style={styles.footnote}>Nenhuma rede é consultada para criar ou verificar este pagamento.</Text>
    </>}

    {screen === "show-challenge" && <>
      <Text style={styles.body}>O payer escaneia este pedido. Depois, toque em receber prova.</Text><FrameCarousel frames={challengeFrames} />
      <Action label="RECEBER PROVA" onPress={beginCredentialScan} /><Action label="Cancelar" secondary onPress={() => setScreen("home")} />
    </>}

    {screen === "verified" && verifiedCredential !== null && <>
      <View style={styles.proof}><Text style={styles.proofAmount}>{verifiedCredential.amount.toString()}</Text><Text style={styles.proofLine}>✓ Session verified</Text><Text style={styles.proofLine}>✓ Signature valid</Text><Text style={styles.proofLine}>✓ Credential integrity</Text><Text style={styles.proofLine}>✓ Guarantee present</Text><View style={styles.pendingBadge}><Text style={styles.pendingBadgeText}>Pending settlement</Text></View></View>
      <Text style={styles.body}>A prova foi persistida antes desta confirmação.</Text>
      <Action label="MOSTRAR CONFIRMAÇÃO" onPress={() => setScreen("show-receipt")} />
    </>}

    {screen === "show-receipt" && <>
      <Text style={styles.body}>O payer lê este recibo de transporte. Ele não é settlement nem amplia cobertura.</Text><FrameCarousel frames={receiptFrames} />
      <Action label="CONCLUIR" onPress={() => { setChallenge(null); setVerifiedCredential(null); setChallengeFrames([]); setReceiptFrames([]); setScreen("home"); }} />
    </>}
  </ScrollView></SafeAreaView>;
}

function equalBytesForStorage(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#eff3f0" }, container: { flexGrow: 1, padding: 24, paddingTop: 48 }, center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: "#eff3f0" },
  eyebrow: { color: "#315dff", fontSize: 12, fontWeight: "800", letterSpacing: 2 }, title: { color: "#111b32", fontSize: 34, fontWeight: "800", marginTop: 10, marginBottom: 28 }, body: { color: "#4d5870", fontSize: 16, lineHeight: 23, textAlign: "center" }, label: { color: "#4d5870", fontWeight: "700", marginBottom: 8 },
  input: { backgroundColor: "#fff", color: "#111b32", borderRadius: 20, padding: 20, fontSize: 42, fontWeight: "800", borderWidth: 1, borderColor: "#dce2df" },
  action: { backgroundColor: "#315dff", borderRadius: 16, padding: 17, alignItems: "center", marginTop: 14 }, actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#a9b4b0" }, actionText: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.5 }, actionTextSecondary: { color: "#33405a" }, disabled: { opacity: 0.45 },
  pending: { backgroundColor: "#111b32", borderRadius: 20, padding: 20, marginTop: 24 }, pendingValue: { color: "#fff", fontSize: 36, fontWeight: "800" }, pendingLabel: { color: "#b8c2dd", marginTop: 3 }, footnote: { color: "#6d7688", fontSize: 12, lineHeight: 17, marginTop: 18 },
  qrCard: { backgroundColor: "#fff", borderRadius: 24, padding: 18, alignItems: "center", marginVertical: 24 }, frameText: { color: "#4d5870", fontWeight: "700", marginTop: 12 },
  proof: { backgroundColor: "#111b32", borderRadius: 24, padding: 25, gap: 13, marginBottom: 20 }, proofAmount: { color: "#fff", fontSize: 50, fontWeight: "900", marginBottom: 8 }, proofLine: { color: "#dce5ff", fontSize: 16, fontWeight: "700" }, pendingBadge: { alignSelf: "flex-start", backgroundColor: "#ffe18a", paddingVertical: 7, paddingHorizontal: 12, borderRadius: 99, marginTop: 8 }, pendingBadgeText: { color: "#5c4500", fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  error: { backgroundColor: "#fee7df", borderRadius: 12, padding: 12, marginBottom: 16 }, errorText: { color: "#8b2c12", fontSize: 13 }, scanner: { flex: 1, backgroundColor: "#000" }, scanOverlay: { flex: 1, justifyContent: "space-between", padding: 28, paddingVertical: 70, backgroundColor: "rgba(0,0,0,0.22)" }, scanTitle: { color: "#fff", fontSize: 24, fontWeight: "800", textAlign: "center" },
});
