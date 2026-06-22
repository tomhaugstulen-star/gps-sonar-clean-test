import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Circle, Marker, Polyline } from "react-native-maps";
import * as Location from "expo-location";

/**
 * MANUELL TEST-RUTE
 *
 * Viktig personvern:
 * - Dette er dummy-/offentlige testkoordinater, ikke private punkter.
 * - Ikke legg inn hjemmekoordinater eller hjemmenære GPS-punkter i repo.
 * - Bytt disse lokalt med egne poster når du tester fysisk.
 * - Hold faktiske poster unna privat bolig, hytte, arbeidssted eller andre sensitive mønstre.
 *
 * Test-ruten under er lagt som en kort runde på ca. 200 meter totalt.
 */
const TEST_ROUTE = {
  id: "manual-test-route-001",
  name: "Manuell Rebus-test, ca. 200 m",
  posts: [
    {
      id: "post-1",
      title: "Post 1",
      latitude: 59.91095,
      longitude: 10.7532,
      radius: 35,
      hint: "Gå til første testpunkt.",
      question: "Hva ser du ved første post?",
      answer: "placeholder",
    },
    {
      id: "post-2",
      title: "Post 2",
      latitude: 59.91125,
      longitude: 10.75385,
      radius: 35,
      hint: "Fortsett til neste punkt.",
      question: "Hva er kjennetegnet ved dette stedet?",
      answer: "placeholder",
    },
    {
      id: "post-3",
      title: "Post 3",
      latitude: 59.91095,
      longitude: 10.7545,
      radius: 35,
      hint: "Du nærmer deg tredje punkt.",
      question: "Hvilket bygg eller landemerke er nærmest?",
      answer: "placeholder",
    },
    {
      id: "post-4",
      title: "Post 4",
      latitude: 59.91065,
      longitude: 10.75385,
      radius: 35,
      hint: "Siste post i ruten.",
      question: "Hva er sluttordet for ruten?",
      answer: "placeholder",
    },
  ],
};

const toRad = (value) => (value * Math.PI) / 180;

function distanceM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatMeters(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "ukjent";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} km`;
  }

  return `${Math.round(value)} m`;
}

function routeCoordinates() {
  return TEST_ROUTE.posts.map((post) => ({
    latitude: post.latitude,
    longitude: post.longitude,
  }));
}

function makeRouteRegion(location) {
  const routePoints = routeCoordinates();
  const points = location
    ? [
        ...routePoints,
        {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        },
      ]
    : routePoints;

  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);

  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);

  const latitude = (minLat + maxLat) / 2;
  const longitude = (minLon + maxLon) / 2;
  const latitudeDelta = Math.max((maxLat - minLat) * 2.4, 0.004);
  const longitudeDelta = Math.max((maxLon - minLon) * 2.4, 0.004);

  return { latitude, longitude, latitudeDelta, longitudeDelta };
}

async function readGpsStatus() {
  const servicesEnabled = await Location.hasServicesEnabledAsync();
  const permission = await Location.getForegroundPermissionsAsync();

  return {
    servicesEnabled,
    status: permission.status,
    granted: permission.granted,
    canAskAgain: permission.canAskAgain,
    expires: String(permission.expires),
  };
}

async function ensureGpsPermission(setGpsStatus) {
  let status = await readGpsStatus();
  setGpsStatus?.(status);

  if (!status.servicesEnabled) {
    Alert.alert("GPS er av", "Slå på posisjonstjenester på telefonen først.");
    return false;
  }

  if (status.status !== "granted") {
    const requested = await Location.requestForegroundPermissionsAsync();

    status = {
      servicesEnabled: await Location.hasServicesEnabledAsync(),
      status: requested.status,
      granted: requested.granted,
      canAskAgain: requested.canAskAgain,
      expires: String(requested.expires),
    };

    setGpsStatus?.(status);
  }

  if (status.status === "granted") {
    return true;
  }

  const message =
    status.canAskAgain === false
      ? "Telefonen sier at appen ikke kan spørre på nytt. Åpne innstillinger og gi posisjonstilgang."
      : "Testen må ha GPS-tilgang.";

  Alert.alert("GPS ikke godkjent", message);
  return false;
}

export default function App() {
  const [gpsStatus, setGpsStatus] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("Starter GPS...");
  const [activeIndex, setActiveIndex] = useState(0);
  const [openedPostIds, setOpenedPostIds] = useState([]);

  const activePost = TEST_ROUTE.posts[activeIndex] || null;
  const routeCompleted = activeIndex >= TEST_ROUTE.posts.length;

  useEffect(() => {
    readGpsStatus().then(setGpsStatus).catch(() => {});
  }, []);

  useEffect(() => {
    let gpsSub;
    let mounted = true;

    async function watch() {
      try {
        const allowed = await ensureGpsPermission(setGpsStatus);

        if (!allowed || !mounted) {
          setStatus("GPS ikke klar.");
          return;
        }

        setStatus("GPS aktiv. Venter på posisjon...");

        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        })
          .then((firstFix) => {
            if (mounted) {
              setLocation(firstFix);
              setStatus("GPS aktiv.");
            }
          })
          .catch((error) => {
            console.log("Første GPS-posisjon feilet:", error?.message || error);
            if (mounted) {
              setStatus("Kart vises. Venter fortsatt på GPS-posisjon.");
            }
          });

        gpsSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          (next) => {
            if (mounted) {
              setLocation(next);
              setStatus("GPS aktiv.");
            }
          }
        );
      } catch (error) {
        console.log("GPS-sporing feilet:", error?.message || error);
        if (mounted) {
          setStatus("Kart vises. GPS-sporing feilet. Sjekk GPS-status.");
        }
      }
    }

    watch();

    return () => {
      mounted = false;
      if (gpsSub) gpsSub.remove();
    };
  }, []);

  const activeDistance = useMemo(() => {
    if (!location || !activePost) return null;

    return distanceM(
      location.coords.latitude,
      location.coords.longitude,
      activePost.latitude,
      activePost.longitude
    );
  }, [location, activePost]);

  const mapRegion = useMemo(() => makeRouteRegion(location), [location]);
  const routeLine = useMemo(() => routeCoordinates(), []);

  const activePostIsOpen = !!activePost && openedPostIds.includes(activePost.id);
  const withinRadius =
    !!activePost &&
    activeDistance !== null &&
    Number.isFinite(activeDistance) &&
    activeDistance <= activePost.radius;

  useEffect(() => {
    if (!activePost || !withinRadius || activePostIsOpen) return;

    setOpenedPostIds((currentIds) => {
      if (currentIds.includes(activePost.id)) return currentIds;
      return [...currentIds, activePost.id];
    });
  }, [activePost, withinRadius, activePostIsOpen]);

  function nextPost() {
    if (!activePostIsOpen) return;
    setActiveIndex((current) => current + 1);
  }

  function openSettings() {
    Linking.openSettings().catch(() => {});
  }

  const gpsAccuracy = location?.coords?.accuracy;
  const routeStatus = routeCompleted
    ? "Ruten er fullført"
    : activePostIsOpen
      ? "post åpnet"
      : "gå nærmere";

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>Rebus GPS-test</Text>
        <Text style={styles.title}>{TEST_ROUTE.name}</Text>

        <View style={styles.mapCard}>
          <MapView
            style={styles.map}
            initialRegion={mapRegion}
            region={mapRegion}
            showsUserLocation={gpsStatus?.status === "granted"}
            showsMyLocationButton={gpsStatus?.status === "granted"}
            loadingEnabled
          >
            <Polyline coordinates={routeLine} strokeWidth={4} strokeColor="#2563eb" />

            {TEST_ROUTE.posts.map((post, index) => {
              const isActive = activePost?.id === post.id;
              const isOpened = openedPostIds.includes(post.id);

              return (
                <React.Fragment key={post.id}>
                  <Circle
                    center={{ latitude: post.latitude, longitude: post.longitude }}
                    radius={post.radius}
                    strokeColor={isActive ? "#f97316" : "#2563eb"}
                    fillColor={isActive ? "rgba(249, 115, 22, 0.18)" : "rgba(37, 99, 235, 0.12)"}
                  />
                  <Marker
                    coordinate={{ latitude: post.latitude, longitude: post.longitude }}
                    title={`${index + 1}. ${post.title}`}
                    description={isOpened ? "Post åpnet" : isActive ? "Aktiv post" : "Ikke åpnet"}
                    pinColor={isOpened ? "green" : isActive ? "orange" : "red"}
                  />
                </React.Fragment>
              );
            })}
          </MapView>
          <View style={styles.mapLegend}>
            <Text style={styles.mapLegendText}>Kartet viser test-ruten uavhengig av GPS-fix.</Text>
            <Text style={styles.mapLegendText}>Oransje = aktiv post. Grønn = åpnet post.</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Status</Text>
          <Text style={styles.statusText}>{routeStatus}</Text>
          <Text style={styles.bodyText}>{status}</Text>
        </View>

        {gpsStatus?.status === "denied" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>GPS-tilgang mangler</Text>
            <Text style={styles.bodyText}>
              Appen trenger posisjonstilgang for å teste Rebus-flyten. Kartet kan likevel vise test-ruten.
            </Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={openSettings} activeOpacity={0.8}>
              <Text style={styles.secondaryButtonText}>Åpne innstillinger</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {routeCompleted ? (
          <View style={styles.card}>
            <Text style={styles.completedTitle}>Ruten er fullført</Text>
            <Text style={styles.bodyText}>Alle poster i test-ruten er åpnet.</Text>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Aktiv post</Text>
              <Text style={styles.postTitle}>
                {activeIndex + 1}. {activePost.title}
              </Text>

              <View style={styles.row}>
                <Text style={styles.label}>Avstand</Text>
                <Text style={styles.value}>{formatMeters(activeDistance)}</Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.label}>Radius</Text>
                <Text style={styles.value}>{activePost.radius} m</Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.label}>GPS-nøyaktighet</Text>
                <Text style={styles.value}>{formatMeters(gpsAccuracy)}</Text>
              </View>
            </View>

            {activePostIsOpen ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Post åpnet</Text>

                <Text style={styles.sectionLabel}>Hint</Text>
                <Text style={styles.bodyText}>{activePost.hint}</Text>

                <Text style={styles.sectionLabel}>Oppgave</Text>
                <Text style={styles.bodyText}>{activePost.question}</Text>

                <TouchableOpacity style={styles.button} onPress={nextPost} activeOpacity={0.8}>
                  <Text style={styles.buttonText}>Neste post</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Gå nærmere</Text>
                <Text style={styles.bodyText}>
                  Posten åpnes automatisk når GPS-posisjonen er innenfor radius.
                </Text>
              </View>
            )}
          </>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Fremdrift</Text>
          <Text style={styles.bodyText}>
            {openedPostIds.length} av {TEST_ROUTE.posts.length} poster åpnet
          </Text>
        </View>

        <View style={styles.debugCard}>
          <Text style={styles.debugTitle}>GPS-status</Text>
          <Text style={styles.debugText}>Tjenester: {String(gpsStatus?.servicesEnabled ?? "ukjent")}</Text>
          <Text style={styles.debugText}>Tillatelse: {gpsStatus?.status ?? "ukjent"}</Text>
          <Text style={styles.debugText}>Kan spørre igjen: {String(gpsStatus?.canAskAgain ?? "ukjent")}</Text>
        </View>

        {location ? (
          <View style={styles.debugCard}>
            <Text style={styles.debugTitle}>Lokal GPS-debug</Text>
            <Text style={styles.debugText}>Lat: {location.coords.latitude}</Text>
            <Text style={styles.debugText}>Lon: {location.coords.longitude}</Text>
            <Text style={styles.debugText}>Accuracy: {formatMeters(location.coords.accuracy)}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101114",
  },
  content: {
    padding: 20,
    gap: 14,
  },
  kicker: {
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  title: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "800",
    marginBottom: 4,
  },
  mapCard: {
    height: 320,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2d3340",
    backgroundColor: "#1c1f26",
  },
  map: {
    flex: 1,
  },
  mapLegend: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 10,
    backgroundColor: "rgba(16, 17, 20, 0.86)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  mapLegendText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  card: {
    backgroundColor: "#1c1f26",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2d3340",
  },
  debugCard: {
    backgroundColor: "#15171c",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2d3340",
  },
  cardTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 10,
  },
  completedTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 8,
  },
  postTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "800",
    marginBottom: 16,
  },
  statusText: {
    color: "#ffffff",
    fontSize: 24,
    fontWeight: "800",
    marginBottom: 8,
  },
  bodyText: {
    color: "#d1d5db",
    fontSize: 16,
    lineHeight: 23,
  },
  sectionLabel: {
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 6,
  },
  label: {
    color: "#9ca3af",
    fontSize: 15,
  },
  value: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  button: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    marginTop: 18,
  },
  buttonText: {
    color: "#101114",
    fontSize: 16,
    fontWeight: "800",
  },
  secondaryButton: {
    borderColor: "#ffffff",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    marginTop: 18,
  },
  secondaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  debugTitle: {
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  debugText: {
    color: "#d1d5db",
    fontSize: 13,
    lineHeight: 19,
  },
});
