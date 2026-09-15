@Entry
@Component
struct Index {
  build() {
    Column() {
      Text('cc-pet')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
