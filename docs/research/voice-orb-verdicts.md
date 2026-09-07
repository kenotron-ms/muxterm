# Voice orb — recorded verdicts

Generated, not hand-written. Regenerate with:

```console
node docs/research/voice-orb-evidence.mjs --verdicts > docs/research/voice-orb-verdicts.md
```

Captured 2026-09-07 08:21:30Z against
`docs/research/voice-orb-mock.html` in headless Chrome. Every number is a
`getComputedStyle` or `getBoundingClientRect` reading taken during a live transition.

The twelve terminal verdicts below are **derived from the 36 measured cells**, not
asserted: a transition passes iff all six criteria hold for it, and a criterion passes
iff it holds on all six transitions. A failing cell propagates to a BLOCKED verdict with
the failing measurement named — there is no path here by which a failure yields a PASS.

## Terminal verdicts

| # | item | verdict | derived from |
|---|---|---|---|
| **T1** | idle → listening | **PASS** | all six criteria hold; see the row below |
| **T2** | listening → thinking | **PASS** | all six criteria hold; see the row below |
| **T3** | thinking → speaking | **PASS** | all six criteria hold; see the row below |
| **T4** | speaking → listening | **PASS** | all six criteria hold; see the row below |
| **T5** | listening → idle | **PASS** | all six criteria hold; see the row below |
| **T6** | speaking → idle | **PASS** | all six criteria hold; see the row below |
| **K1** | no discontinuous jump | **PASS** | holds on all six transitions; per-transition measurements below |
| **K2** | no snap-through-base | **PASS** | holds on all six transitions; per-transition measurements below |
| **K3** | interruptible | **PASS** | holds on all six transitions; per-transition measurements below |
| **K4** | compositor-only | **PASS** | holds on all six transitions; per-transition measurements below |
| **K5** | reduced motion | **PASS** | holds on all six transitions; per-transition measurements below |
| **K6** | duration and easing stated | **PASS** | holds on all six transitions; per-transition measurements below |
| **Persona** | use the AI Elements persona component | **ADOPTED** | state model (`persona.tsx:281-294`) and layered visual approach ported to Lit; timing values NOT PORTABLE — the upstream source contains none. See `persona-reference/README.md`. |

**BLOCKED items: 0.** Every item carries PASS, so no BLOCKED reasons are required. Had any cell failed, the verdict above would read BLOCKED with the failing measurement named.

## The 36 cells

| transition | K1<br>no discontinuous jump | K2<br>no snap-through-base | K3<br>interruptible | K4<br>compositor-only | K5<br>reduced motion | K6<br>duration and easing stated |
|---|---|---|---|---|---|---|
| **T1** idle → listening | PASS | PASS | PASS | PASS | PASS | PASS |
| **T2** listening → thinking | PASS | PASS | PASS | PASS | PASS | PASS |
| **T3** thinking → speaking | PASS | PASS | PASS | PASS | PASS | PASS |
| **T4** speaking → listening | PASS | PASS | PASS | PASS | PASS | PASS |
| **T5** listening → idle | PASS | PASS | PASS | PASS | PASS | PASS |
| **T6** speaking → idle | PASS | PASS | PASS | PASS | PASS | PASS |

### The measurement in every cell

#### T1  idle → listening

- **K1** PASS — velocity x nominal: glow 2.73, rect 1.62 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4838 (mid-flight); seam d(glow) 0.02969; velocity 2.68
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 0; glow d 0.28; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 422 / 422 ms (stated 420, spread 0ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T1 — every frame, contiguous</summary>

```
glow 0.3400 -> 0.6200   K2: every sample must lie inside [0.3400, 0.6200]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.02094         --   0.34000         --     1.0000   0.0000   ok
      --  settled      1.02061   -0.00033   0.34000   +0.00000     1.0000   0.0000   ok
    16.6  transition   1.02043   -0.00017   0.34089   +0.00089     1.0000   0.0032   ok
    33.4  transition   1.02069   +0.00026   0.34411   +0.00322     1.0000   0.0147   ok
    49.9  transition   1.02147   +0.00078   0.35036   +0.00625     1.0000   0.0370   ok
    66.7  transition   1.02293   +0.00146   0.36051   +0.01015     1.0000   0.0732   ok
    83.5  transition   1.02528   +0.00234   0.37584   +0.01533     1.0000   0.1280   ok
    99.9  transition   1.02864   +0.00336   0.39733   +0.02149     1.0000   0.2047   ok
   116.5  transition   1.03289   +0.00425   0.42447   +0.02714     1.0000   0.3017   ok
   133.2  transition   1.03752   +0.00463   0.45466   +0.03019     1.0000   0.4095   ok
   150.0  transition   1.04174   +0.00421   0.48347   +0.02881     1.0000   0.5124   ok
   166.5  transition   1.04516   +0.00343   0.50878   +0.02531     1.0000   0.6028   ok
   183.3  transition   1.04772   +0.00256   0.52998   +0.02120     1.0000   0.6785   ok
   199.8  transition   1.04952   +0.00180   0.54749   +0.01751     1.0000   0.7410   ok
   217.6  transition   1.05071   +0.00118   0.56196   +0.01447     1.0000   0.7927   ok
   233.7  transition   1.05138   +0.00067   0.57386   +0.01190     1.0000   0.8352   ok
   250.0  transition   1.05165   +0.00027   0.58378   +0.00992     1.0000   0.8707   ok
   266.5  transition   1.05161   -0.00005   0.59196   +0.00818     1.0000   0.8999   ok
   283.1  transition   1.05131   -0.00030   0.59875   +0.00679     1.0000   0.9241   ok
   299.8  transition   1.05080   -0.00051   0.60429   +0.00554     1.0000   0.9439   ok
   316.4  transition   1.05013   -0.00067   0.60882   +0.00453     1.0000   0.9601   ok
   333.1  transition   1.04932   -0.00081   0.61242   +0.00360     1.0000   0.9729   ok
   350.0  transition   1.04842   -0.00090   0.61521   +0.00279     1.0000   0.9829   ok
   366.5  transition   1.04745   -0.00097   0.61730   +0.00209     1.0000   0.9904   ok
   383.4  transition   1.04643   -0.00102   0.61875   +0.00145     1.0000   0.9955   ok
   401.3  transition   1.04536   -0.00107   0.61963   +0.00088     1.0000   0.9987   ok
   417.2  transition   1.04429   -0.00107   0.61999   +0.00036     1.0000   1.0000   ok
   433.5  transition   1.04323   -0.00106   0.62000   +0.00001     0.0000   1.0000   ok
   449.9  transition   1.04224   -0.00099   0.62000   +0.00000     0.0000   1.0000   ok
   466.5  transition   1.04132   -0.00093   0.62000   +0.00000     0.0000   1.0000   ok
   483.2  transition   1.04046   -0.00086   0.62000   +0.00000     0.0000   1.0000   ok
   499.7  transition   1.03967   -0.00079   0.62000   +0.00000     0.0000   1.0000   ok
   517.3  transition   1.03896   -0.00071   0.62000   +0.00000     0.0000   1.0000   ok
   537.2  transition   1.03832   -0.00064   0.62000   +0.00000     0.0000   1.0000   ok
   550.6  transition   1.03776   -0.00056   0.62000   +0.00000     0.0000   1.0000   ok
   566.4  transition   1.03728   -0.00048   0.62000   +0.00000     0.0000   1.0000   ok
   583.0  transition   1.03688   -0.00040   0.62000   +0.00000     0.0000   1.0000   ok
```

</details>

#### T2  listening → thinking

- **K1** PASS — velocity x nominal: glow 2.71, rect 2.17 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.9793: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "speaking" at 140ms with incoming weight 0.4892 (mid-flight); seam d(glow) 0.00739; velocity 2.19
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 65.47; glow d 0.07; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 423 / 423 ms (stated 420, spread 1ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T2 — every frame, contiguous</summary>

```
glow 0.6200 -> 0.5500   K2: every sample must lie inside [0.5500, 0.6200]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.07326         --   0.62000         --     1.0000   0.0000   ok
      --  settled      1.07311   -0.00015   0.62000   +0.00000     1.0000   0.0000   ok
    14.5  transition   1.07289   -0.00022   0.61984   -0.00016     1.0000   0.0023   ok
    30.7  transition   1.07261   -0.00028   0.61913   -0.00071     1.0000   0.0124   ok
    48.5  transition   1.07228   -0.00033   0.61770   -0.00143     1.0000   0.0328   ok
    65.3  transition   1.07190   -0.00038   0.61531   -0.00239     1.0000   0.0670   ok
    80.9  transition   1.07145   -0.00045   0.61168   -0.00363     1.0000   0.1188   ok
    97.5  transition   1.07096   -0.00050   0.60654   -0.00514     1.0000   0.1923   ok
   114.3  transition   1.07037   -0.00058   0.59993   -0.00661     1.0000   0.2867   ok
   130.7  transition   1.06968   -0.00069   0.59242   -0.00751     1.0000   0.3940   ok
   147.5  transition   1.06886   -0.00083   0.58513   -0.00729     1.0000   0.4982   ok
   164.3  transition   1.06790   -0.00095   0.57865   -0.00648     1.0000   0.5907   ok
   180.8  transition   1.06684   -0.00106   0.57324   -0.00541     1.0000   0.6680   ok
   197.5  transition   1.06568   -0.00116   0.56873   -0.00451     1.0000   0.7324   ok
   214.0  transition   1.06444   -0.00124   0.56501   -0.00372     1.0000   0.7856   ok
   230.7  transition   1.06314   -0.00130   0.56193   -0.00308     1.0000   0.8295   ok
   247.5  transition   1.06178   -0.00136   0.55938   -0.00255     1.0000   0.8660   ok
   264.2  transition   1.06038   -0.00140   0.55728   -0.00210     1.0000   0.8960   ok
   280.7  transition   1.05895   -0.00143   0.55554   -0.00174     1.0000   0.9209   ok
   297.5  transition   1.05751   -0.00144   0.55411   -0.00143     1.0000   0.9413   ok
   315.6  transition   1.05605   -0.00147   0.55294   -0.00117     1.0000   0.9579   ok
   331.4  transition   1.05458   -0.00146   0.55201   -0.00093     1.0000   0.9713   ok
   347.5  transition   1.05314   -0.00144   0.55128   -0.00073     1.0000   0.9817   ok
   364.2  transition   1.05172   -0.00142   0.55074   -0.00054     1.0000   0.9894   ok
   380.7  transition   1.05034   -0.00138   0.55036   -0.00038     1.0000   0.9949   ok
   397.4  transition   1.04902   -0.00132   0.55012   -0.00024     1.0000   0.9983   ok
   414.1  transition   1.04775   -0.00127   0.55001   -0.00011     1.0000   0.9999   ok
   430.8  transition   1.04657   -0.00119   0.55000   -0.00001     0.0000   1.0000   ok
   447.3  transition   1.04548   -0.00109   0.55000   +0.00000     0.0000   1.0000   ok
   464.0  transition   1.04450   -0.00098   0.55000   +0.00000     0.0000   1.0000   ok
   480.8  transition   1.04363   -0.00087   0.55000   +0.00000     0.0000   1.0000   ok
   497.5  transition   1.04291   -0.00072   0.55000   +0.00000     0.0000   1.0000   ok
   514.2  transition   1.04231   -0.00060   0.55000   +0.00000     0.0000   1.0000   ok
   530.8  transition   1.04185   -0.00045   0.55000   +0.00000     0.0000   1.0000   ok
   547.6  transition   1.04156   -0.00030   0.55000   +0.00000     0.0000   1.0000   ok
   564.2  transition   1.04140   -0.00015   0.55000   +0.00000     0.0000   1.0000   ok
   581.0  transition   1.04142   +0.00001   0.55000   +0.00000     0.0000   1.0000   ok
```

</details>

#### T3  thinking → speaking

- **K1** PASS — velocity x nominal: glow 2.69, rect 0.73 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.9793: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "listening" at 140ms with incoming weight 0.4910 (mid-flight); seam d(glow) 0.02004; velocity 2.80
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 81.92; glow d 0.19; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 423 / 423 ms (stated 420, spread 1ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T3 — every frame, contiguous</summary>

```
glow 0.5500 -> 0.7400   K2: every sample must lie inside [0.5500, 0.7400]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.06427         --   0.55000         --     1.0000   0.0000   ok
      --  settled      1.06279   -0.00148   0.55000   +0.00000     1.0000   0.0000   ok
    16.6  transition   1.06139   -0.00139   0.55059   +0.00059     1.0000   0.0031   ok
    33.2  transition   1.06011   -0.00128   0.55275   +0.00216     1.0000   0.0145   ok
    49.6  transition   1.05895   -0.00116   0.55693   +0.00418     1.0000   0.0365   ok
    66.3  transition   1.05791   -0.00105   0.56381   +0.00688     1.0000   0.0727   ok
    83.1  transition   1.05694   -0.00096   0.57410   +0.01029     1.0000   0.1268   ok
    99.6  transition   1.05602   -0.00092   0.58860   +0.01450     1.0000   0.2032   ok
   116.2  transition   1.05511   -0.00090   0.60708   +0.01848     1.0000   0.3004   ok
   132.8  transition   1.05420   -0.00092   0.62756   +0.02048     1.0000   0.4082   ok
   149.6  transition   1.05334   -0.00085   0.64713   +0.01957     1.0000   0.5112   ok
   166.3  transition   1.05265   -0.00069   0.66434   +0.01721     1.0000   0.6018   ok
   183.9  transition   1.05462   +0.00197   0.67868   +0.01434     1.0000   0.6773   ok
   201.1  transition   1.06077   +0.00615   0.69060   +0.01192     1.0000   0.7400   ok
   216.9  transition   1.06632   +0.00555   0.70040   +0.00980     1.0000   0.7916   ok
   233.1  transition   1.07153   +0.00521   0.70856   +0.00816     1.0000   0.8345   ok
   249.6  transition   1.07649   +0.00496   0.71531   +0.00675     1.0000   0.8701   ok
   266.3  transition   1.08134   +0.00485   0.72091   +0.00560     1.0000   0.8995   ok
   283.0  transition   1.08612   +0.00478   0.72553   +0.00462     1.0000   0.9238   ok
   299.6  transition   1.09084   +0.00472   0.72930   +0.00377     1.0000   0.9437   ok
   316.3  transition   1.09554   +0.00470   0.73236   +0.00306     1.0000   0.9598   ok
   333.0  transition   1.10026   +0.00471   0.73482   +0.00246     1.0000   0.9727   ok
   349.6  transition   1.10491   +0.00466   0.73673   +0.00191     1.0000   0.9828   ok
   367.2  transition   1.10949   +0.00458   0.73815   +0.00142     1.0000   0.9903   ok
   385.6  transition   1.11395   +0.00445   0.73914   +0.00099     1.0000   0.9955   ok
   399.8  transition   1.11820   +0.00425   0.73974   +0.00060     1.0000   0.9986   ok
   416.1  transition   1.12227   +0.00406   0.73999   +0.00025     1.0000   0.9999   ok
   433.0  transition   1.12610   +0.00383   0.74000   +0.00001     0.0000   1.0000   ok
   450.3  transition   1.12975   +0.00365   0.74000   +0.00000     0.0000   1.0000   ok
   467.0  transition   1.13323   +0.00348   0.74000   +0.00000     0.0000   1.0000   ok
   483.0  transition   1.13642   +0.00320   0.74000   +0.00000     0.0000   1.0000   ok
   499.6  transition   1.13935   +0.00292   0.74000   +0.00000     0.0000   1.0000   ok
   516.2  transition   1.14191   +0.00256   0.74000   +0.00000     0.0000   1.0000   ok
   532.9  transition   1.14411   +0.00220   0.74000   +0.00000     0.0000   1.0000   ok
   549.5  transition   1.14588   +0.00177   0.74000   +0.00000     0.0000   1.0000   ok
   566.1  transition   1.14721   +0.00132   0.74000   +0.00000     0.0000   1.0000   ok
   582.9  transition   1.14806   +0.00085   0.74000   +0.00000     0.0000   1.0000   ok
```

</details>

#### T4  speaking → listening

- **K1** PASS — velocity x nominal: glow 2.68, rect 0.37 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 1.0082: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4795 (mid-flight); seam d(glow) 0.01276; velocity 1.90
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 45.78; glow d 0.12; 42 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 422 / 422 / 423 ms (stated 420, spread 1ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T4 — every frame, contiguous</summary>

```
glow 0.7400 -> 0.6200   K2: every sample must lie inside [0.6200, 0.7400]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.12412         --   0.74000         --     1.0000   0.0000   ok
      --  settled      1.12239   -0.00173   0.74000   +0.00000     1.0000   0.0000   ok
    16.6  transition   1.12009   -0.00230   0.73964   -0.00036     0.9970   1.0000   ok
    32.8  transition   1.11707   -0.00302   0.73827   -0.00137     0.9856   1.0000   ok
    49.6  transition   1.11339   -0.00368   0.73564   -0.00263     0.9637   1.0000   ok
    66.2  transition   1.10899   -0.00441   0.73131   -0.00433     0.9276   1.0000   ok
    82.9  transition   1.10387   -0.00511   0.72483   -0.00648     0.8736   1.0000   ok
    99.8  transition   1.09807   -0.00580   0.71568   -0.00915     0.7974   1.0000   ok
   116.4  transition   1.09182   -0.00625   0.70410   -0.01158     0.7008   1.0000   ok
   133.0  transition   1.08545   -0.00637   0.69109   -0.01301     0.5924   1.0000   ok
   149.7  transition   1.07958   -0.00586   0.67872   -0.01237     0.4894   1.0000   ok
   166.4  transition   1.07438   -0.00521   0.66784   -0.01088     0.3987   1.0000   ok
   183.1  transition   1.06987   -0.00451   0.65878   -0.00906     0.3232   1.0000   ok
   199.7  transition   1.06591   -0.00396   0.65124   -0.00754     0.2603   1.0000   ok
   216.5  transition   1.06241   -0.00349   0.64501   -0.00623     0.2084   1.0000   ok
   233.1  transition   1.05932   -0.00309   0.63986   -0.00515     0.1655   1.0000   ok
   249.8  transition   1.05656   -0.00276   0.63561   -0.00425     0.1301   1.0000   ok
   266.3  transition   1.05406   -0.00250   0.63208   -0.00353     0.1006   1.0000   ok
   283.2  transition   1.05179   -0.00227   0.62917   -0.00291     0.0764   1.0000   ok
   299.8  transition   1.04971   -0.00208   0.62678   -0.00239     0.0565   1.0000   ok
   316.4  transition   1.04780   -0.00191   0.62483   -0.00195     0.0403   1.0000   ok
   333.1  transition   1.04604   -0.00176   0.62328   -0.00155     0.0273   1.0000   ok
   349.7  transition   1.04441   -0.00163   0.62207   -0.00121     0.0173   1.0000   ok
   366.4  transition   1.04289   -0.00152   0.62117   -0.00090     0.0098   1.0000   ok
   383.0  transition   1.04151   -0.00139   0.62055   -0.00062     0.0046   1.0000   ok
   399.8  transition   1.04021   -0.00130   0.62017   -0.00038     0.0014   1.0000   ok
   416.5  transition   1.03903   -0.00119   0.62001   -0.00016     0.0001   1.0000   ok
   433.1  transition   1.03791   -0.00111   0.62000   -0.00001     0.0000   1.0000   ok
   449.5  transition   1.03686   -0.00106   0.62000   +0.00000     0.0000   1.0000   ok
   466.2  transition   1.03588   -0.00097   0.62000   +0.00000     0.0000   1.0000   ok
   482.9  transition   1.03497   -0.00091   0.62000   +0.00000     0.0000   1.0000   ok
   499.5  transition   1.03412   -0.00085   0.62000   +0.00000     0.0000   1.0000   ok
   516.2  transition   1.03336   -0.00076   0.62000   +0.00000     0.0000   1.0000   ok
   532.9  transition   1.03266   -0.00069   0.62000   +0.00000     0.0000   1.0000   ok
   549.6  transition   1.03204   -0.00062   0.62000   +0.00000     0.0000   1.0000   ok
   566.2  transition   1.03150   -0.00054   0.62000   +0.00000     0.0000   1.0000   ok
   582.9  transition   1.03103   -0.00046   0.62000   +0.00000     0.0000   1.0000   ok
```

</details>

#### T5  listening → idle

- **K1** PASS — velocity x nominal: glow 2.71, rect 1.06 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4892 (mid-flight); seam d(glow) 0.02940; velocity 2.69
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 0; glow d 0.28; 43 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 421 / 423 / 423 ms (stated 420, spread 2ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T5 — every frame, contiguous</summary>

```
glow 0.6200 -> 0.3400   K2: every sample must lie inside [0.3400, 0.6200]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.07126         --   0.62000         --     1.0000   0.0000   ok
      --  settled      1.07132   +0.00005   0.62000   +0.00000     1.0000   0.0000   ok
    16.5  transition   1.07111   -0.00020   0.61913   -0.00087     0.9969   1.0000   ok
    32.9  transition   1.07035   -0.00076   0.61594   -0.00319     0.9855   1.0000   ok
    49.6  transition   1.06890   -0.00145   0.60973   -0.00621     0.9633   1.0000   ok
    66.2  transition   1.06658   -0.00232   0.59964   -0.01009     0.9273   1.0000   ok
    83.2  transition   1.06316   -0.00342   0.58438   -0.01526     0.8728   1.0000   ok
    99.9  transition   1.05848   -0.00468   0.56312   -0.02126     0.7968   1.0000   ok
   116.5  transition   1.05252   -0.00596   0.53571   -0.02741     0.6990   1.0000   ok
   133.3  transition   1.04607   -0.00645   0.50570   -0.03001     0.5918   1.0000   ok
   149.9  transition   1.03986   -0.00621   0.47669   -0.02901     0.4882   1.0000   ok
   166.6  transition   1.03445   -0.00542   0.45135   -0.02534     0.3977   1.0000   ok
   183.2  transition   1.02992   -0.00453   0.43026   -0.02109     0.3223   1.0000   ok
   199.8  transition   1.02614   -0.00378   0.41270   -0.01756     0.2596   1.0000   ok
   216.6  transition   1.02298   -0.00315   0.39820   -0.01450     0.2079   1.0000   ok
   233.3  transition   1.02039   -0.00259   0.38634   -0.01186     0.1655   1.0000   ok
   249.9  transition   1.01820   -0.00220   0.37638   -0.00996     0.1299   1.0000   ok
   266.5  transition   1.01634   -0.00185   0.36813   -0.00825     0.1005   1.0000   ok
   283.2  transition   1.01479   -0.00155   0.36132   -0.00681     0.0761   1.0000   ok
   299.9  transition   1.01351   -0.00129   0.35577   -0.00555     0.0563   1.0000   ok
   316.6  transition   1.01243   -0.00108   0.35123   -0.00454     0.0401   1.0000   ok
   333.2  transition   1.01153   -0.00090   0.34761   -0.00362     0.0272   1.0000   ok
   349.7  transition   1.01080   -0.00073   0.34482   -0.00279     0.0172   1.0000   ok
   366.5  transition   1.01021   -0.00060   0.34272   -0.00210     0.0097   1.0000   ok
   383.2  transition   1.00974   -0.00046   0.34127   -0.00145     0.0045   1.0000   ok
   399.9  transition   1.00939   -0.00036   0.34038   -0.00089     0.0014   1.0000   ok
   416.5  transition   1.00913   -0.00025   0.34002   -0.00036     0.0001   1.0000   ok
   433.1  transition   1.00895   -0.00018   0.34000   -0.00002     0.0000   1.0000   ok
   449.7  transition   1.00876   -0.00018   0.34000   +0.00000     0.0000   1.0000   ok
   466.3  transition   1.00857   -0.00019   0.34000   +0.00000     0.0000   1.0000   ok
   483.0  transition   1.00839   -0.00018   0.34000   +0.00000     0.0000   1.0000   ok
   499.7  transition   1.00819   -0.00019   0.34000   +0.00000     0.0000   1.0000   ok
   516.5  transition   1.00799   -0.00020   0.34000   +0.00000     0.0000   1.0000   ok
   533.0  transition   1.00780   -0.00019   0.34000   +0.00000     0.0000   1.0000   ok
   549.8  transition   1.00760   -0.00019   0.34000   +0.00000     0.0000   1.0000   ok
   566.4  transition   1.00740   -0.00020   0.34000   +0.00000     0.0000   1.0000   ok
   583.1  transition   1.00719   -0.00020   0.34000   +0.00000     0.0000   1.0000   ok
```

</details>

#### T6  speaking → idle

- **K1** PASS — velocity x nominal: glow 2.68, rect 0.95 (threshold 6; a jump is ~25)
- **K2** PASS — glow-interval violations 0; frames below geometric floor 0.974: 0; weights monotone true; largest third-state weight 0.0e+0
- **K3** PASS — interrupted by "thinking" at 140ms with incoming weight 0.4819 (mid-flight); seam d(glow) 0.04247; velocity 2.70
- **K4** PASS — properties written: [opacity, transform]
- **K5** PASS — rect span 0.0e+0; colour dRGB 45.79; glow d 0.4; 43 distinct values
- **K6** PASS — duration recovered from the DOM at y=.25/.50/.75: 421 / 423 / 422 ms (stated 420, spread 1ms)

<details><summary>the captured measurement behind K1, K2 and K3 for T6 — every frame, contiguous</summary>

```
glow 0.7400 -> 0.3400   K2: every sample must lie inside [0.3400, 0.7400]

     ms  phase        rect      d(rect)     glow     d(glow)  tint[from] tint[to]   K2
  ------------------------------------------------------------------------------------
      --  settled      1.12804         --   0.74000         --     1.0000   0.0000   ok
      --  settled      1.12665   -0.00139   0.74000   +0.00000     1.0000   0.0000   ok
    16.7  transition   1.12451   -0.00213   0.73869   -0.00131     0.9967   1.0000   ok
    33.5  transition   1.12121   -0.00331   0.73405   -0.00464     0.9851   1.0000   ok
    50.1  transition   1.11662   -0.00458   0.72513   -0.00892     0.9628   1.0000   ok
    67.5  transition   1.11055   -0.00607   0.71049   -0.01464     0.9262   1.0000   ok
    83.5  transition   1.10285   -0.00770   0.68865   -0.02184     0.8716   1.0000   ok
   100.4  transition   1.09325   -0.00960   0.65768   -0.03097     0.7942   1.0000   ok
   117.0  transition   1.08229   -0.01096   0.61883   -0.03885     0.6971   1.0000   ok
   133.6  transition   1.07095   -0.01134   0.57594   -0.04289     0.5898   1.0000   ok
   150.3  transition   1.06040   -0.01055   0.53434   -0.04160     0.4859   1.0000   ok
   166.7  transition   1.05154   -0.00886   0.49848   -0.03586     0.3962   1.0000   ok
   183.4  transition   1.04421   -0.00733   0.46828   -0.03020     0.3207   1.0000   ok
   200.0  transition   1.03828   -0.00593   0.44345   -0.02483     0.2586   1.0000   ok
   216.8  transition   1.03343   -0.00485   0.42281   -0.02064     0.2070   1.0000   ok
   233.4  transition   1.02946   -0.00397   0.40583   -0.01698     0.1646   1.0000   ok
   250.1  transition   1.02618   -0.00328   0.39159   -0.01424     0.1290   1.0000   ok
   266.8  transition   1.02351   -0.00267   0.37993   -0.01166     0.0998   1.0000   ok
   283.5  transition   1.02130   -0.00220   0.37025   -0.00968     0.0756   1.0000   ok
   300.1  transition   1.01951   -0.00179   0.36235   -0.00790     0.0559   1.0000   ok
   316.8  transition   1.01804   -0.00146   0.35594   -0.00641     0.0398   1.0000   ok
   333.5  transition   1.01687   -0.00117   0.35077   -0.00517     0.0269   1.0000   ok
   350.0  transition   1.01596   -0.00091   0.34680   -0.00397     0.0170   1.0000   ok
   366.9  transition   1.01526   -0.00070   0.34384   -0.00296     0.0096   1.0000   ok
   383.4  transition   1.01476   -0.00050   0.34176   -0.00208     0.0044   1.0000   ok
   400.2  transition   1.01443   -0.00033   0.34053   -0.00123     0.0013   1.0000   ok
   416.8  transition   1.01425   -0.00018   0.34002   -0.00051     0.0001   1.0000   ok
   433.4  transition   1.01416   -0.00009   0.34000   -0.00002     0.0000   1.0000   ok
   450.0  transition   1.01410   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   466.8  transition   1.01402   -0.00008   0.34000   +0.00000     0.0000   1.0000   ok
   483.4  transition   1.01394   -0.00008   0.34000   +0.00000     0.0000   1.0000   ok
   500.1  transition   1.01387   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   516.7  transition   1.01380   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   533.4  transition   1.01373   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   550.0  transition   1.01367   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   566.8  transition   1.01359   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
   583.1  transition   1.01353   -0.00007   0.34000   +0.00000     0.0000   1.0000   ok
```

</details>

## Where the rest of the evidence lives

| | |
|---|---|
| unreduced per-frame samples, all six transitions + three interrupts | `docs/research/voice-orb-samples.txt` |
| which technique is running, measured at runtime | `--technique` (`getAnimations()` = 0, Σw = 1.000000) |
| the artifact's controls, driven by clicking them | `--ui` |
| the technique asserted in CI, mutation-proven | `web/src/lib/orb-persona.test.ts` (30 tests, `npm test`) |
| the engine | `web/src/lib/orb-persona.ts` |
| the artifact | `docs/research/voice-orb-mock.html` |

