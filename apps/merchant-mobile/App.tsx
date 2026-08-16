import { useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { credentialHash, validateCredentialProofBundle } from "@ogp/credentials";
import { derivePublicKey, generateChallenge, generateSecretKey } from "@ogp/crypto";
import { OgpValidationError, equalBytes, type PaymentCredential } from "@ogp/shared-types";
import { QRTransport, validateMerchantResponse, type MerchantChallenge } from "@ogp/transports";
import { createStoredClaim, findPotentialConflictHashes, markReceiptShown, parseStoredClaims, shortHash, type ClaimBranchDescriptor, type ClaimLifecycleStatus, type StoredClaim } from "./src/claim-history";
import { bytesToHex, expectedEnvironment, hexToBytes } from "./src/trust";

const transport = new QRTransport();
const DEVICE_KEY_STORAGE = "ogp.merchant.device-key";
const CLAIMS_STORAGE = "ogp.merchant.pending-claims";
const OUTSTANDING_STORAGE = "ogp.merchant.outstanding-challenge";
const merchantWallet = new Uint8Array(32).fill(0x71); // Public development identity only; no wallet secret exists in this app.

type Screen = "home" | "show-challenge" | "scan-credential" | "verified" | "show-receipt" | "history" | "claim-detail";

interface StoredOutstandingChallenge {
  readonly amount: string;
  readonly challenge: string;
  readonly merchantDeviceKey: string;
}

function errorText(error: unknown): string {
  if (error instanceof OgpValidationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Falha inesperada";
}

function claimStatusText(status: ClaimLifecycleStatus): string {
  if (status === "pending-submission") return "Aguardando reconexão e envio";
  if (status === "submitted") return "Última sincronização: claim confirmado";
  if (status === "settled") return "Última sincronização: liquidação confirmada";
  return "Última sincronização: rejeição confirmada";
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
  if (!permission.granted) return <View style={styles.center}><Text style={styles.body}>A câmera lê a prova portátil diretamente do pagador.</Text><Action label="Permitir câmera" onPress={() => void requestPermission()} /><Action label="Cancelar" secondary onPress={onCancel} /></View>;
  const scanned = ({ data }: BarcodeScanningResult) => onCode(data);
  return <View style={styles.scanner}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned} /><View style={styles.scanOverlay}><Text style={styles.scanTitle}>Leia todas as partes do pagador</Text><Action label="Cancelar" secondary onPress={onCancel} /></View></View>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [amountText, setAmountText] = useState("100");
  const [merchantDeviceKey, setMerchantDeviceKey] = useState<Uint8Array | null>(null);
  const [challenge, setChallenge] = useState<MerchantChallenge | null>(null);
  const [challengeFrames, setChallengeFrames] = useState<readonly string[]>([]);
  const [receiptFrames, setReceiptFrames] = useState<readonly string[]>([]);
  const [verifiedCredential, setVerifiedCredential] = useState<PaymentCredential | null>(null);
  const [claims, setClaims] = useState<StoredClaim[]>([]);
  const [selectedClaimHash, setSelectedClaimHash] = useState<string | null>(null);
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
      const storedClaims = parseStoredClaims(await AsyncStorage.getItem(CLAIMS_STORAGE));
      setClaims(storedClaims);
      const outstandingJson = await AsyncStorage.getItem(OUTSTANDING_STORAGE);
      if (outstandingJson !== null) {
        const outstanding = JSON.parse(outstandingJson) as StoredOutstandingChallenge;
        if (!equalBytesForStorage(devicePublicKey, hexToBytes(outstanding.merchantDeviceKey))) throw new Error("O pedido persistido pertence a outro dispositivo");
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
        if (challenge === null || merchantDeviceKey === null) throw new Error("Nenhum pedido ativo");
        const bundle = transport.receiveCredential(receivedFrames.current);
        const { credential } = validateMerchantResponse(expectedEnvironment, challenge, bundle);

        const hash = credentialHash(credential);
        const storedClaims = parseStoredClaims(await AsyncStorage.getItem(CLAIMS_STORAGE));
        const hashHex = bytesToHex(hash);
        if (!storedClaims.some((claim) => claim.credentialHash === hashHex)) {
          storedClaims.push(createStoredClaim({ credentialHash: hashHex, amount: credential.amount.toString(), sessionId: bytesToHex(credential.sessionId), frames: [...receivedFrames.current] }));
          await AsyncStorage.setItem(CLAIMS_STORAGE, JSON.stringify(storedClaims));
        }
        await AsyncStorage.removeItem(OUTSTANDING_STORAGE);
        setClaims(storedClaims);
        setVerifiedCredential(credential);
        setReceiptFrames(transport.sendReceipt({ credentialHash: hash, merchantChallenge: credential.merchantChallenge }));
        setScreen("verified");
      } catch (reason) {
        if (!(reason instanceof OgpValidationError) || reason.code !== "INCOMPLETE_QR_TRANSFER") setError(errorText(reason));
      }
    })();
  };

  const claimInspections = useMemo(() => claims.map((claim) => {
    try {
      const bundle = transport.receiveCredential(claim.frames);
      const finalCredential = bundle.credentials.at(-1);
      if (finalCredential === undefined) throw new Error("A prova não contém credenciais");
      const context = { ...expectedEnvironment, sessionId: bundle.sessionCertificate.sessionId };
      validateCredentialProofBundle(context, bundle);
      if (
        bytesToHex(credentialHash(finalCredential)) !== claim.credentialHash ||
        bytesToHex(finalCredential.sessionId) !== claim.sessionId ||
        finalCredential.amount.toString() !== claim.amount ||
        !equalBytes(finalCredential.merchant, merchantWallet) ||
        (merchantDeviceKey !== null && !equalBytes(finalCredential.merchantDeviceKey, merchantDeviceKey))
      ) throw new Error("Os metadados locais não correspondem à prova");
      const descriptors = bundle.credentials.map((credential): ClaimBranchDescriptor => ({
        credentialHash: claim.credentialHash,
        sessionId: claim.sessionId,
        parentStateHash: bytesToHex(credential.previousStateHash),
        sequence: credential.sequence,
        resultingStateHash: bytesToHex(credential.newStateHash),
      }));
      return { claim, descriptors, valid: true as const };
    } catch {
      return { claim, descriptors: [] as ClaimBranchDescriptor[], valid: false as const };
    }
  }), [claims, merchantDeviceKey]);
  const claimDescriptors = useMemo(() => claimInspections.flatMap((inspection) => inspection.descriptors), [claimInspections]);
  const potentialConflictHashes = useMemo(() => findPotentialConflictHashes(claimDescriptors), [claimDescriptors]);
  const selectedClaim = claims.find((claim) => claim.credentialHash === selectedClaimHash) ?? null;
  const selectedInspection = claimInspections.find((inspection) => inspection.claim.credentialHash === selectedClaimHash) ?? null;
  const selectedDescriptor = selectedInspection?.descriptors.at(-1) ?? null;

  const openClaim = (credentialHash: string) => {
    setSelectedClaimHash(credentialHash);
    setScreen("claim-detail");
  };

  const showReceipt = async () => {
    if (verifiedCredential === null) return;
    try {
      const updatedClaims = markReceiptShown(claims, bytesToHex(credentialHash(verifiedCredential)));
      await AsyncStorage.setItem(CLAIMS_STORAGE, JSON.stringify(updatedClaims));
      setClaims(updatedClaims);
      setScreen("show-receipt");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  if (screen === "scan-credential") return <Scanner onCode={scanCredential} onCancel={() => setScreen("show-challenge")} />;

  return <SafeAreaView style={styles.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>GARANTIA OFFLINE</Text>
    <Text style={styles.title}>{screen === "home" ? "Receber sem internet" : screen === "show-challenge" ? "Mostre ao pagador" : screen === "verified" ? "Pagamento validado" : screen === "show-receipt" ? "Confirmação" : screen === "history" ? "Histórico de provas" : "Detalhes da prova"}</Text>
    {error !== null && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}

    {screen === "home" && <>
      <Text style={styles.label}>Valor</Text><TextInput value={amountText} onChangeText={setAmountText} keyboardType="number-pad" style={styles.input} accessibilityLabel="Valor do pagamento" />
      <Action label="CRIAR PEDIDO" disabled={merchantDeviceKey === null} onPress={() => void createRequest()} />
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Abrir histórico de provas" onPress={() => setScreen("history")} style={styles.pending}><Text style={styles.pendingValue}>{claims.length}</Text><Text style={styles.pendingLabel}>prova(s) armazenada(s) · {claims.filter((claim) => claim.status === "pending-submission").length} aguardando envio</Text><Text style={styles.pendingLink}>TOQUE PARA VER O HISTÓRICO →</Text></TouchableOpacity>
      <Text style={styles.footnote}>Nenhuma rede é consultada para criar ou verificar este pagamento.</Text>
    </>}

    {screen === "show-challenge" && <>
      <Text style={styles.body}>O pagador escaneia este pedido. Depois, toque em receber prova.</Text><FrameCarousel frames={challengeFrames} />
      <Action label="RECEBER PROVA" onPress={beginCredentialScan} /><Action label="Cancelar" secondary onPress={() => setScreen("home")} />
    </>}

    {screen === "verified" && verifiedCredential !== null && <>
      <View style={styles.proof}><Text style={styles.proofAmount}>{verifiedCredential.amount.toString()}</Text><Text style={styles.proofLine}>✓ Sessão verificada</Text><Text style={styles.proofLine}>✓ Assinatura válida</Text><Text style={styles.proofLine}>✓ Credencial íntegra</Text><Text style={styles.proofLine}>✓ Garantia presente</Text><View style={styles.pendingBadge}><Text style={styles.pendingBadgeText}>Aguardando reconexão</Text></View></View>
      <Text style={styles.body}>A prova foi persistida antes desta confirmação.</Text>
      <Action label="MOSTRAR CONFIRMAÇÃO" onPress={() => void showReceipt()} />
    </>}

    {screen === "show-receipt" && <>
      <Text style={styles.body}>O pagador lê este recibo de transporte. Ele não é liquidação e não amplia a cobertura.</Text><FrameCarousel frames={receiptFrames} />
      <Action label="CONCLUIR" onPress={() => { setChallenge(null); setVerifiedCredential(null); setChallengeFrames([]); setReceiptFrames([]); setScreen("home"); }} />
    </>}

    {screen === "history" && <>
      <Text style={styles.bodyLeft}>Cada item abaixo é uma prova criptográfica distinta armazenada neste aparelho.</Text>
      {claims.length === 0 && <View style={styles.empty}><Text style={styles.emptyTitle}>Nenhuma prova armazenada</Text><Text style={styles.bodyLeft}>Os pagamentos verificados aparecerão aqui.</Text></View>}
      {[...claims].reverse().map((claim, reverseIndex) => {
        const valid = claimInspections.find((inspection) => inspection.claim.credentialHash === claim.credentialHash)?.valid === true;
        return <TouchableOpacity key={claim.credentialHash} accessibilityRole="button" onPress={() => openClaim(claim.credentialHash)} style={styles.claimCard}>
        <View style={styles.claimHeader}><Text style={styles.claimTitle}>Pagamento {claims.length - reverseIndex}</Text><Text style={styles.claimAmount}>{claim.amount}</Text></View>
        <Text style={valid ? styles.verifiedLabel : styles.invalidLabel}>{valid ? "✓ Prova revalidada e armazenada" : "⚠ Prova local inválida ou corrompida"}</Text>
        <Text style={claim.status === "settled" ? styles.settledLabel : claim.status === "rejected" ? styles.invalidLabel : styles.pendingDetail}>{claimStatusText(claim.status)}</Text>
        {valid && potentialConflictHashes.has(claim.credentialHash) && <Text style={styles.conflictLabel}>⚠ Possível conflito local</Text>}
        <Text style={styles.claimMeta}>Credencial {shortHash(claim.credentialHash)}</Text>
        <Text style={styles.claimLink}>VER DETALHES →</Text>
      </TouchableOpacity>;})}
      <Action label="VOLTAR" secondary onPress={() => setScreen("home")} />
    </>}

    {screen === "claim-detail" && selectedClaim !== null && <>
      <View style={styles.detailCard}>
        <Text style={styles.detailLabel}>Valor</Text><Text style={styles.detailAmount}>{selectedClaim.amount}</Text>
        {selectedInspection?.valid === true ? <><Text style={styles.verifiedLabel}>✓ Sessão revalidada</Text><Text style={styles.verifiedLabel}>✓ Assinatura válida</Text><Text style={styles.verifiedLabel}>✓ Credencial íntegra</Text><Text style={styles.verifiedLabel}>✓ Prova armazenada</Text></> : <Text style={styles.invalidLabel}>⚠ A prova armazenada não passou na revalidação local e não deve ser apresentada como garantia.</Text>}
        <View style={styles.divider} />
        <Text style={styles.detailLabel}>Registro local da última sincronização</Text><Text style={selectedClaim.status === "settled" ? styles.settledLabel : selectedClaim.status === "rejected" ? styles.invalidLabel : styles.pendingDetail}>{claimStatusText(selectedClaim.status)}</Text>
        {selectedClaim.lastConfirmedSlot !== null && <><Text style={styles.detailLabel}>Slot confirmado observado</Text><Text style={styles.detailValue}>{selectedClaim.lastConfirmedSlot}</Text></>}
        {selectedClaim.transactionSignature !== null && <><Text style={styles.detailLabel}>Transação observada</Text><Text style={styles.hashText}>{shortHash(selectedClaim.transactionSignature)}</Text></>}
        {selectedClaim.submissionAttempts > 0 && <><Text style={styles.detailLabel}>Tentativas de envio</Text><Text style={styles.detailValue}>{selectedClaim.submissionAttempts}</Text></>}
        {selectedClaim.lastSubmissionError !== null && <><Text style={styles.detailLabel}>Última falha de rede</Text><Text style={styles.invalidLabel}>{selectedClaim.lastSubmissionError}</Text></>}
        <Text style={styles.detailLabel}>Confirmação mostrada ao pagador</Text>
        <Text style={styles.detailValue}>{selectedClaim.receiptPresentation === "shown" ? "Sim — a leitura pelo pagador não é observável" : selectedClaim.receiptPresentation === "not-shown" ? "Ainda não" : "Não determinada nesta versão do aplicativo"}</Text>
        {selectedInspection?.valid === true && potentialConflictHashes.has(selectedClaim.credentialHash) && <View style={styles.conflictBox}><Text style={styles.conflictTitle}>Possível conflito local</Text><Text style={styles.conflictBody}>Outra prova armazenada usa a mesma sessão, o mesmo estado anterior e a mesma sequência, mas chega a outro estado. A confirmação protocolar ocorrerá somente na reconciliação on-chain.</Text></View>}
        <Text style={styles.detailLabel}>Sessão</Text><Text style={styles.hashText}>{shortHash(selectedClaim.sessionId)}</Text>
        <Text style={styles.detailLabel}>Credencial</Text><Text style={styles.hashText}>{shortHash(selectedClaim.credentialHash)}</Text>
        {selectedDescriptor !== null && <><Text style={styles.detailLabel}>Sequência</Text><Text style={styles.detailValue}>{selectedDescriptor.sequence}</Text><Text style={styles.detailLabel}>Estado anterior</Text><Text style={styles.hashText}>{shortHash(selectedDescriptor.parentStateHash)}</Text><Text style={styles.detailLabel}>Estado resultante</Text><Text style={styles.hashText}>{shortHash(selectedDescriptor.resultingStateHash)}</Text></>}
      </View>
      <Action label="VOLTAR AO HISTÓRICO" secondary onPress={() => setScreen("history")} />
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
  pending: { backgroundColor: "#111b32", borderRadius: 20, padding: 20, marginTop: 24 }, pendingValue: { color: "#fff", fontSize: 36, fontWeight: "800" }, pendingLabel: { color: "#b8c2dd", marginTop: 3 }, pendingLink: { color: "#8fa7ff", fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginTop: 14 }, footnote: { color: "#6d7688", fontSize: 12, lineHeight: 17, marginTop: 18 },
  qrCard: { backgroundColor: "#fff", borderRadius: 24, padding: 18, alignItems: "center", marginVertical: 24 }, frameText: { color: "#4d5870", fontWeight: "700", marginTop: 12 },
  proof: { backgroundColor: "#111b32", borderRadius: 24, padding: 25, gap: 13, marginBottom: 20 }, proofAmount: { color: "#fff", fontSize: 50, fontWeight: "900", marginBottom: 8 }, proofLine: { color: "#dce5ff", fontSize: 16, fontWeight: "700" }, pendingBadge: { alignSelf: "flex-start", backgroundColor: "#ffe18a", paddingVertical: 7, paddingHorizontal: 12, borderRadius: 99, marginTop: 8 }, pendingBadgeText: { color: "#5c4500", fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  error: { backgroundColor: "#fee7df", borderRadius: 12, padding: 12, marginBottom: 16 }, errorText: { color: "#8b2c12", fontSize: 13 }, scanner: { flex: 1, backgroundColor: "#000" }, scanOverlay: { flex: 1, justifyContent: "space-between", padding: 28, paddingVertical: 70, backgroundColor: "rgba(0,0,0,0.22)" }, scanTitle: { color: "#fff", fontSize: 24, fontWeight: "800", textAlign: "center" },
  bodyLeft: { color: "#4d5870", fontSize: 16, lineHeight: 23 }, empty: { backgroundColor: "#fff", borderRadius: 20, padding: 22, marginTop: 20 }, emptyTitle: { color: "#111b32", fontSize: 18, fontWeight: "800", marginBottom: 6 }, claimCard: { backgroundColor: "#fff", borderRadius: 20, padding: 20, marginTop: 14, borderWidth: 1, borderColor: "#dce2df" }, claimHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, claimTitle: { color: "#111b32", fontSize: 17, fontWeight: "800" }, claimAmount: { color: "#111b32", fontSize: 28, fontWeight: "900" }, verifiedLabel: { color: "#167763", fontSize: 14, fontWeight: "700", marginTop: 10 }, settledLabel: { color: "#167763", fontSize: 15, fontWeight: "900", marginTop: 10 }, invalidLabel: { color: "#a6371b", fontSize: 14, fontWeight: "800", lineHeight: 20, marginTop: 10 }, conflictLabel: { color: "#9b5b00", fontSize: 13, fontWeight: "800", marginTop: 8 }, claimMeta: { color: "#6d7688", fontSize: 12, marginTop: 10 }, claimLink: { color: "#315dff", fontSize: 12, fontWeight: "800", marginTop: 14 }, detailCard: { backgroundColor: "#fff", borderRadius: 24, padding: 22, borderWidth: 1, borderColor: "#dce2df" }, detailLabel: { color: "#6d7688", fontSize: 12, fontWeight: "700", marginTop: 16, marginBottom: 4, textTransform: "uppercase" }, detailAmount: { color: "#111b32", fontSize: 48, fontWeight: "900" }, detailValue: { color: "#111b32", fontSize: 15, lineHeight: 21 }, pendingDetail: { color: "#8b6400", fontSize: 15, fontWeight: "800", marginTop: 10 }, hashText: { color: "#33405a", fontSize: 13, fontWeight: "700" }, divider: { height: 1, backgroundColor: "#e4e8e5", marginTop: 20 }, conflictBox: { backgroundColor: "#fff2d6", borderRadius: 14, padding: 14, marginTop: 18 }, conflictTitle: { color: "#7a4700", fontSize: 15, fontWeight: "900" }, conflictBody: { color: "#7a5520", fontSize: 13, lineHeight: 19, marginTop: 6 },
});
