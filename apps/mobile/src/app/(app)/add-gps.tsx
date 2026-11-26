// Adding a GPS on site: the vehicle, the device's model and its IMEI, and then
// how to point the device at this platform while the app waits for its first
// signal. Same steps and rules as the web app's (AddGpsWizard.tsx).
import type { Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { CircleCheck } from "lucide-react-native";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ModalScreen } from "../../components/ModalScreen";
import { Button, Card, Field, Notice } from "../../components/ui";
import { createVehicle, errorText, getDeviceModels } from "../../lib/api";
import { cleanId, fillSetup, isValidId, type ModelOption, modelOptions, OPTIONS_SHOWN } from "../../lib/gps";
import { isSheetOpen, select } from "../../lib/selection";
import { useConfig, useNow } from "../../lib/session";
import { FONT, RADIUS, useTheme } from "../../lib/theme";
import { useTyped } from "../../lib/typed";
import { useVehicles } from "../../lib/vehicles";

type Step = "vehicle" | "device" | "setup";

export default function AddGpsScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("vehicle");
  const name = useTyped();
  const plate = useTyped();
  const [option, setOption] = useState<ModelOption | null>(null);
  const [created, setCreated] = useState<Vehicle | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (uniqueId: string) =>
      createVehicle({ name: name.latest().trim(), plate: plate.latest().trim(), uniqueId, modelId: option?.modelId ?? "", modelName: option?.modelName ?? null }),
    onSuccess: async (vehicle) => {
      setCreated(vehicle);
      setStep("setup");
      await queryClient.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  const title = step === "setup" ? t("wizard.title.setup") : t("wizard.title.add");
  return (
    <ModalScreen title={title} testID="add-gps-screen">
      <Steps step={step} />
      {step === "vehicle" ? (
        <>
          <Field
            label={t("wizard.name")}
            value={name.text}
            onChangeText={(text) => {
              name.change(text);
              setProblem(null);
            }}
            placeholder={t("wizard.namePlaceholder")}
            maxLength={60}
            testID="gps-name"
          />
          <Field label={t("wizard.plate")} value={plate.text} onChangeText={plate.change} autoCapitalize="characters" maxLength={20} testID="gps-plate" />
          {problem ? <Notice text={problem} /> : null}
          <Button
            label={t("wizard.next")}
            onPress={() => {
              if (!name.latest().trim()) return setProblem(t("wizard.needName"));
              setProblem(null);
              setStep("device");
            }}
            testID="gps-next"
          />
        </>
      ) : step === "device" ? (
        <DeviceStep
          option={option}
          onOption={setOption}
          busy={add.isPending}
          error={add.isError ? errorText(add.error) : null}
          onBack={() => setStep("vehicle")}
          onSubmit={(uniqueId) => add.mutate(uniqueId)}
        />
      ) : created && option ? (
        <SetupStep vehicle={created} option={option} />
      ) : null}
    </ModalScreen>
  );
}

function Steps(props: { step: Step }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const steps: Step[] = ["vehicle", "device", "setup"];
  const at = steps.indexOf(props.step);
  return (
    <View style={styles.steps}>
      {steps.map((s, i) => (
        <View key={s} style={styles.stepItem}>
          <View style={[styles.stepBar, { backgroundColor: i <= at ? theme.signalInk : theme.line }]} />
          <Text style={[styles.stepText, { color: i === at ? theme.ink : theme.muted }]}>{t(`wizard.steps.${s}`)}</Text>
        </View>
      ))}
    </View>
  );
}

function DeviceStep(props: {
  option: ModelOption | null;
  onOption: (option: ModelOption | null) => void;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (uniqueId: string) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const models = useQuery({ queryKey: ["device-models"], queryFn: getDeviceModels, staleTime: Number.POSITIVE_INFINITY });
  const [query, setQuery] = useState("");
  const id = useTyped();
  const [problem, setProblem] = useState<string | null>(null);
  const { option } = props;
  const options = models.data ? modelOptions(models.data, query) : [];
  const idLabel = option?.family.idLabel ?? "IMEI";

  const submit = () => {
    if (!option) return setProblem(t("wizard.needModel"));
    const clean = cleanId(id.latest());
    if (!isValidId(clean)) return setProblem(t("wizard.badId", { idLabel }));
    setProblem(null);
    props.onSubmit(clean);
  };

  return (
    <>
      {option ? (
        <Card style={styles.chosen}>
          <View style={styles.chosenText}>
            <Text style={[styles.chosenName, { color: theme.ink }]}>{option.modelName ?? t("wizard.other", { family: option.family.brand })}</Text>
            <Text style={[styles.small, { color: theme.muted }]}>{t("wizard.chosen", { family: option.family.name, port: option.family.port })}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => props.onOption(null)} hitSlop={8} testID="gps-model-change">
            <Text style={[styles.link, { color: theme.signalInk }]}>{t("wizard.change")}</Text>
          </Pressable>
        </Card>
      ) : (
        <View style={styles.block}>
          <Text style={[styles.label, { color: theme.muted }]}>{t("wizard.find")}</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("wizard.findPlaceholder")}
            placeholderTextColor={theme.faint}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            style={[styles.search, { color: theme.ink, backgroundColor: theme.surface, borderColor: theme.line }]}
            testID="gps-model-search"
          />
          {models.isPending ? <ActivityIndicator color={theme.muted} /> : null}
          {models.isSuccess && options.length === 0 ? <Notice tone="note" text={t("wizard.empty")} /> : null}
          <Card style={styles.options}>
            {options.slice(0, OPTIONS_SHOWN).map((o, i) => (
              <Pressable
                key={`${o.modelId}|${o.modelName ?? ""}`}
                accessibilityRole="button"
                onPress={() => props.onOption(o)}
                style={({ pressed }) => [styles.option, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }, { opacity: pressed ? 0.6 : 1 }]}
                testID={`gps-model-${i}`}
              >
                <Text style={[styles.optionName, { color: theme.ink }]}>{o.modelName ?? t("wizard.other", { family: o.family.brand })}</Text>
                <Text style={[styles.small, { color: theme.muted }]}>{o.family.name}</Text>
              </Pressable>
            ))}
          </Card>
        </View>
      )}

      <View style={styles.block}>
        <Field
          label={t("wizard.deviceId", { idLabel })}
          value={id.text}
          onChangeText={(text) => {
            id.change(text);
            setProblem(null);
          }}
          keyboardType="number-pad"
          autoCorrect={false}
          maxLength={24}
          testID="gps-imei"
        />
        <Notice tone="note" text={idLabel === "IMEI" ? t("wizard.imeiHint") : t("wizard.idHint")} />
      </View>
      {problem ? <Notice text={problem} testID="gps-problem" /> : null}
      {props.error ? <Notice text={props.error} testID="gps-error" /> : null}
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button kind="secondary" label={t("wizard.back")} onPress={props.onBack} />
        </View>
        <View style={styles.action}>
          <Button label={t("wizard.submit")} busy={props.busy} onPress={submit} testID="gps-submit" />
        </View>
      </View>
    </>
  );
}

/** How to point the device at this platform, while the app waits for its first signal. */
function SetupStep(props: { vehicle: Vehicle; option: ModelOption }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const config = useConfig().data;
  const now = useNow(20_000);
  // The live channel updates the list: the device turns active with its first signal, or disappears if time runs out.
  const vehicles = useVehicles();
  const live = vehicles.data?.find((v) => v.id === props.vehicle.id);
  const device = vehicles.isSuccess ? (live?.device ?? null) : props.vehicle.device;
  const { family } = props.option;
  const where = { host: config?.gatewayHost ?? "", ip: config?.gatewayIp ?? null, port: family.port };

  if (device?.status === "active") {
    return (
      <Card style={styles.done} testID="gps-connected">
        <CircleCheck color={theme.signalInk} size={36} />
        <Text style={[styles.doneTitle, { color: theme.ink }]}>{t("wizard.reporting", { name: props.vehicle.name })}</Text>
        <Text style={[styles.note, { color: theme.muted }]}>{t("wizard.firstSignal")}</Text>
        <Button
          label={t("wizard.showOnMap")}
          onPress={() => {
            router.back();
            select(props.vehicle.id);
            router.navigate("/");
            if (!isSheetOpen()) router.push("/vehicle");
          }}
          testID="gps-show"
        />
      </Card>
    );
  }
  if (!device) return <Notice text={t("wizard.expired")} testID="gps-expired" />;

  const minutes = device.claimExpiresAt ? Math.max(0, Math.ceil((Date.parse(device.claimExpiresAt) - now) / 60_000)) : null;
  return (
    <>
      <Card style={styles.waiting} testID="gps-waiting">
        <ActivityIndicator color={theme.signalInk} />
        <View style={styles.chosenText}>
          <Text style={[styles.chosenName, { color: theme.ink }]}>{t("wizard.waiting.title")}</Text>
          <Text style={[styles.small, { color: theme.muted }]}>
            {minutes !== null ? t("wizard.waiting.updatesMinutes", { n: minutes }) : t("wizard.waiting.updates")}
          </Text>
        </View>
      </Card>
      <Card style={styles.where}>
        <Copyable label={t("wizard.server")} value={where.host} />
        <Copyable label={t("wizard.port")} value={String(where.port)} />
      </Card>
      {family.setup.map((s, i) => (
        <View key={s.title} style={styles.setupStep}>
          <Text style={[styles.setupTitle, { color: theme.ink }]}>
            {i + 1}. {s.title}
          </Text>
          <Text style={[styles.note, { color: theme.muted }]}>{fillSetup(s.text, where)}</Text>
          {s.command ? (
            <Text selectable style={[styles.command, { color: theme.ink, backgroundColor: theme.surface, borderColor: theme.line }]}>
              {fillSetup(s.command, where)}
            </Text>
          ) : null}
        </View>
      ))}
      <Text style={[styles.small, { color: theme.muted }]}>{t("wizard.commandsNote", { brand: family.brand })}</Text>
      <Button kind="secondary" label={t("wizard.later")} onPress={() => router.back()} testID="gps-later" />
    </>
  );
}

function Copyable(props: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.copyRow}>
      <Text style={[styles.label, { color: theme.muted }]}>{props.label}</Text>
      <Text selectable style={[styles.copyValue, { color: theme.ink }]}>
        {props.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: "row", gap: 8 },
  stepItem: { flex: 1, gap: 6 },
  stepBar: { height: 4, borderRadius: 2 },
  stepText: { fontFamily: FONT.medium, fontSize: 12 },
  block: { gap: 8 },
  label: { fontFamily: FONT.medium, fontSize: 13 },
  search: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontFamily: FONT.regular, fontSize: 16 },
  options: { paddingVertical: 4 },
  option: { paddingVertical: 10, gap: 2 },
  optionName: { fontFamily: FONT.medium, fontSize: 15 },
  chosen: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  chosenText: { flex: 1, gap: 2 },
  chosenName: { fontFamily: FONT.semibold, fontSize: 16 },
  small: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  link: { fontFamily: FONT.semibold, fontSize: 14 },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14 },
  where: { paddingVertical: 12, gap: 8 },
  copyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  copyValue: { fontFamily: FONT.mono, fontSize: 15 },
  setupStep: { gap: 6 },
  setupTitle: { fontFamily: FONT.semibold, fontSize: 15 },
  note: { fontFamily: FONT.regular, fontSize: 14, lineHeight: 20 },
  command: { fontFamily: FONT.mono, fontSize: 13, padding: 10, borderRadius: RADIUS - 4, borderWidth: StyleSheet.hairlineWidth },
  done: { alignItems: "center", gap: 10, paddingVertical: 20 },
  doneTitle: { fontFamily: FONT.bold, fontSize: 18, textAlign: "center" },
});
